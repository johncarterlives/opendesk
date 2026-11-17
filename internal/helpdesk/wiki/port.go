package wiki

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/wikiport"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Import and export (contracts/wiki.md "Import and export"): wikiport reads and writes the
// files; this is where they meet the workspace's wiki, its limits and who sees what.

const (
	// maxImportBody leaves room for the multipart envelope around wikiport's upload limit.
	maxImportBody = wikiport.MaxUploadBytes + 1<<20
	// importsPerHour and exportsPerHour bound a workspace's imports and a caller's zips.
	importsPerHour = 20
	exportsPerHour = 30
	// maxExportText is the most page text one export reads.
	maxExportText = 200 << 20
	// maxExportFiles is the most file bytes one zip carries; files past it link to the app.
	maxExportFiles = 1 << 30
	// portDeadline is how long an import or a zip may take on the wire.
	portDeadline = 10 * time.Minute
)

type importForm struct {
	Files    []huma.FormFile `form:"files" required:"true" doc:"One zip (Obsidian vault, Notion or Confluence export, Markdown or HTML files), or Markdown, HTML, CSV, text and Obsidian canvas files with the files they use; up to 100 MB in all"`
	ParentID string          `form:"parent_id" required:"false" doc:"The page to import under; left out, the top level of space"`
	Space    string          `form:"space" required:"false" doc:"workspace (default), private or team: where top-level pages go"`
	TeamID   string          `form:"team_id" required:"false" doc:"The teamspace, with space team"`
	Area     string          `form:"area" required:"false" enum:"wiki,pages" doc:"wiki (default) or pages (contracts/pages.md): the tree top-level pages go in; under parent_id, the parent's"`
}

// ImportResult is what an import made.
type ImportResult struct {
	Pages   int             `json:"pages" doc:"How many pages it made"`
	RootIDs []uuid.UUID     `json:"root_ids" doc:"The pages it made at the top of the import, in order"`
	Skipped []wikiport.Skip `json:"skipped" doc:"What it left out or changed, by path in the upload, with a reason code (contracts/wiki.md \"Import and export\")"`
}

// exportInput is what an export of the whole wiki takes.
type exportInput struct {
	Format string `query:"format" enum:"markdown,html" default:"markdown" doc:"markdown: an Obsidian-friendly vault; html: standalone pages"`
}

// portBody caps an import's body before huma reads the form (to temporary files), and gives
// the request the time an upload of that size takes.
func portBody(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		r, w := humachi.Unwrap(ctx)
		if r.ContentLength > maxImportBody {
			_ = huma.WriteErr(api, ctx, http.StatusRequestEntityTooLarge, wikiport.ErrTooLarge.Detail)
			return
		}
		rc := http.NewResponseController(w)
		_ = rc.SetReadDeadline(time.Now().Add(portDeadline))
		_ = rc.SetWriteDeadline(time.Now().Add(portDeadline))
		r.Body = http.MaxBytesReader(w, r.Body, maxImportBody)
		next(ctx)
	}
}

func registerPort(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "import-wiki", Method: http.MethodPost, Path: "/v1/wiki/import",
		Summary: "Import pages into the wiki", Tags: tags, DefaultStatus: http.StatusCreated, MaxBodyBytes: maxImportBody,
		Middlewares: huma.Middlewares{portBody(api)},
		Description: "Reads an Obsidian vault, a Notion, Confluence or Google Docs export, or Markdown, HTML, CSV, text and canvas files, and makes their pages " +
			"under `parent_id` or at the top level of `space`, all at once: links between them, their files (as attachments), Notion databases with their rows and Obsidian canvases. " +
			"`422 wiki_full` when the pages would not fit in the workspace's 5,000. Programs and scripts are never imported."},
		func(ctx context.Context, in *struct {
			RawBody huma.MultipartFormFiles[importForm]
		}) (*struct{ Body ImportResult }, error) {
			if in.RawBody.Form != nil {
				defer func(f *multipart.Form) { _ = f.RemoveAll() }(in.RawBody.Form)
			}
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeWikiWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			form := in.RawBody.Data()
			if form == nil || len(form.Files) == 0 {
				return nil, httpx.Validation("files is required")
			}
			uploads := make([]wikiport.Upload, 0, len(form.Files))
			for _, f := range form.Files {
				if f.File == nil {
					continue
				}
				defer f.Close()
				uploads = append(uploads, wikiport.Upload{Name: f.Filename, Body: f.File, Size: f.Size})
			}
			if !d.Limiter.Allow("wiki:import:"+p.WorkspaceID.String(), importsPerHour, time.Hour) {
				return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Too many imports. Try again later.")
			}
			out, err := importPages(ctx, d, p, form, uploads)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body ImportResult }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "export-wiki-page", Method: http.MethodGet, Path: "/v1/wiki/pages/{id}/export",
		Summary: "Export a wiki page", Tags: tags,
		Description: "A download: the page as one Markdown or HTML file, or, with `subpages=true` and subpages the caller may see, a zip of the page, " +
			"its subpages (databases with their rows) and the workspace's files they use. Pages in the trash and pages out of the caller's sight are left out."},
		func(ctx context.Context, in *struct {
			ID       string `path:"id"`
			Format   string `query:"format" enum:"markdown,html" default:"markdown" doc:"markdown: an Obsidian-friendly vault; html: standalone pages"`
			Subpages bool   `query:"subpages" doc:"With its subpages: a zip of the page and every subpage the caller may see"`
		}) (*huma.StreamResponse, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Page")
			if err != nil {
				return nil, err
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			format := wikiport.Format(in.Format)
			root, err := exportRoot(ctx, d.DB.Pool, v, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			pages := []wikiport.ExportPage{root.page}
			if in.Subpages {
				if pages, err = subtreePages(ctx, d.DB.Pool, v, p.WorkspaceID, id, root.template); err != nil {
					return nil, httpx.Wrap(err)
				}
			}
			ex := newExport(d, p, v, format)
			if len(pages) == 1 {
				return ex.file(pages[0])
			}
			first := wikiport.ExportFileName(pages[0], format)
			name := strings.TrimSuffix(first, path.Ext(first)) + ".zip"
			return ex.zip(ctx, name, pages, &id)
		})

	huma.Register(api, huma.Operation{OperationID: "export-wiki", Method: http.MethodGet, Path: "/v1/wiki/export",
		Summary: "Export the wiki", Tags: tags,
		Description: "A zip of every page of the caller's tree of one area (the workspace's pages, the teamspaces they may see and their own private pages; not the trash, not templates), " +
			"databases with their rows and the workspace's files the pages use. Any member exports what they may read."},
		func(ctx context.Context, in *struct {
			Format string `query:"format" enum:"markdown,html" default:"markdown" doc:"markdown: an Obsidian-friendly vault; html: standalone pages"`
			Area   string `query:"area" enum:"wiki,pages" default:"wiki" doc:"Whose pages: the wiki's or Pages' (contracts/pages.md)"`
		}) (*huma.StreamResponse, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeWikiRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if err := requireArea(ctx, d.DB.Pool, p.WorkspaceID, in.Area); err != nil {
				return nil, httpx.Wrap(err)
			}
			v, err := viewerFor(ctx, d, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			pages, err := treePages(ctx, d.DB.Pool, v, p.WorkspaceID, in.Area)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if len(pages) == 0 {
				return nil, httpx.E(http.StatusUnprocessableEntity, "wiki_empty", "There are no pages to export yet.")
			}
			ex := newExport(d, p, v, wikiport.Format(in.Format))
			name := "Wiki"
			if in.Area == AreaPages {
				name = "Pages"
			}
			return ex.zip(ctx, name+" "+time.Now().UTC().Format(time.DateOnly)+".zip", pages, nil)
		})
}

// --- import -----------------------------------------------------------------------------

// importPages makes the pages of an upload: it reads the upload, checks there is room, stores
// the files it uses, then creates every page in one transaction. Files stored for an import
// that then fails are removed again; none is left that no page holds.
func importPages(ctx context.Context, d *deps.Deps, p *auth.Principal, form *importForm, uploads []wikiport.Upload) (ImportResult, error) {
	var size int64
	for _, u := range uploads {
		size += u.Size
	}
	if size > wikiport.MaxUploadBytes {
		return ImportResult{}, wikiport.ErrTooLarge
	}
	v, err := viewerFor(ctx, d, p)
	if err != nil {
		return ImportResult{}, err
	}
	// Where it lands, checked before reading the upload; again in the transaction.
	dest, err := resolveDest(ctx, d.DB.Pool, v, p.WorkspaceID, form)
	if err != nil {
		return ImportResult{}, err
	}
	res, err := wikiport.Import(uploads, wikiport.Options{Depth: maxDepth - dest.depth})
	if err != nil {
		return ImportResult{}, err
	}
	count := res.Count()
	if err := roomForImport(ctx, d.DB.Pool, p.WorkspaceID, count); err != nil {
		return ImportResult{}, err
	}
	refs, stored, skips, err := storeAssets(ctx, d, p, res)
	if err != nil {
		dropFiles(d, p.WorkspaceID, stored)
		return ImportResult{}, err
	}
	for _, pg := range res.Pages {
		assignIDs(pg, refs)
	}
	var out ImportResult
	err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
		out = ImportResult{Pages: count, RootIDs: []uuid.UUID{}, Skipped: append(append([]wikiport.Skip{}, res.Skipped...), skips...)}
		if err := lockTree(ctx, tx, p.WorkspaceID); err != nil {
			return err
		}
		if err := roomForImport(ctx, tx, p.WorkspaceID, count); err != nil {
			return err
		}
		dest, err := resolveDest(ctx, tx, v, p.WorkspaceID, form)
		if err != nil {
			return err
		}
		if dest.depth+height(res.Pages) > maxDepth {
			return tooDeep()
		}
		im := &importer{ctx: ctx, tx: tx, p: p, res: res, ids: refs, dest: dest}
		for _, pg := range res.Pages {
			id, err := im.create(pg, dest.parent, nil, -1)
			if err != nil {
				return err
			}
			out.RootIDs = append(out.RootIDs, id)
		}
		out.Skipped = append(out.Skipped, im.skips...)
		if err := im.finish(); err != nil {
			return err
		}
		data := map[string]any{"pages": count, "files": len(stored), "skipped": len(out.Skipped), "parent_id": dest.parent}
		return audit.Log(ctx, tx, p, p.WorkspaceID, "wiki_page.imported", "wiki_page", &out.RootIDs[0], data)
	})
	if err != nil {
		dropFiles(d, p.WorkspaceID, stored)
		return ImportResult{}, err
	}
	return out, nil
}

// importDest is where an import lands: under a page the caller may write in, or at the
// top level of a space.
type importDest struct {
	parent      *uuid.UUID
	owner, team *uuid.UUID
	template    bool
	area        string
	depth       int // levels above the import's top pages
}

func resolveDest(ctx context.Context, q db.Querier, v Viewer, wid uuid.UUID, form *importForm) (importDest, error) {
	par, err := parentRef(ctx, q, v, wid, &form.ParentID)
	if err != nil {
		return importDest{}, err
	}
	var dest importDest
	if par != nil {
		if par.database != nil {
			return dest, httpx.E(http.StatusUnprocessableEntity, "import_into_database", "Pages can't be imported into a database. Pick a page, or the top level.")
		}
		dest = importDest{parent: &par.id, owner: par.owner, team: par.team, template: par.template, area: par.area, depth: len(par.up) + 1}
	} else {
		dest.area = AreaWiki
		if form.Area == AreaPages {
			dest.area = AreaPages
		}
		if err := requireArea(ctx, q, wid, dest.area); err != nil {
			return dest, err
		}
		var team *string
		if form.TeamID != "" {
			team = &form.TeamID
		}
		if dest.owner, dest.team, err = spaceRef(ctx, q, v, wid, form.Space, team); err != nil {
			return dest, err
		}
	}
	if dest.depth >= maxDepth {
		return dest, tooDeep()
	}
	return dest, nil
}

// roomForImport refuses an import whose pages don't fit in the wiki's limit.
func roomForImport(ctx context.Context, q db.Querier, wid uuid.UUID, n int) error {
	var count int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE workspace_id = $1`, wid).Scan(&count); err != nil {
		return err
	}
	if count+n > maxPages {
		return httpx.E(http.StatusUnprocessableEntity, "wiki_full", fmt.Sprintf(
			"This import makes %d pages and the wiki has room for %d more: it holds up to 5,000, the trash included. Delete pages you no longer need, or import a smaller part.",
			n, max(maxPages-count, 0)))
	}
	return nil
}

func height(ps []*wikiport.Page) int {
	h := 0
	for _, p := range ps {
		h = max(h, 1+height(p.Children))
	}
	return h
}

func assignIDs(pg *wikiport.Page, refs map[string]string) {
	refs[pg.Ref] = ids.New().String()
	for _, c := range pg.Children {
		assignIDs(c, refs)
	}
}

// storedFile is an attachment an import stored.
type storedFile struct {
	id  uuid.UUID
	key string
}

// storeAssets uploads the files the pages use as the caller's imported attachments, within
// the plan's import limit (contracts/billing.md "Imports"), and answers ref → id for each
// stored. A file refused (a program found by its bytes, over 25 MB, past the limit) is
// listed as skipped; the bodies drop what used it.
func storeAssets(ctx context.Context, d *deps.Deps, p *auth.Principal, res *wikiport.Result) (map[string]string, []storedFile, []wikiport.Skip, error) {
	ids := map[string]string{}
	var stored []storedFile
	var skips []wikiport.Skip
	if len(res.Assets) == 0 {
		return ids, nil, nil, nil
	}
	e, err := d.Plan.Entitlements(ctx, d.DB.Pool, p.WorkspaceID)
	if err != nil {
		return nil, nil, nil, err
	}
	var used int64
	if e.ImportBytes > 0 {
		if err := d.DB.Pool.QueryRow(ctx, `SELECT COALESCE(sum(size_bytes), 0)::bigint FROM attachments WHERE workspace_id = $1 AND imported`,
			p.WorkspaceID).Scan(&used); err != nil {
			return nil, nil, nil, err
		}
	}
	for _, a := range res.Assets {
		size := int64(len(a.Data))
		if e.ImportBytes > 0 && used+size > e.ImportBytes {
			skips = append(skips, wikiport.Skip{Path: a.Key, Reason: "files_limit"})
			continue
		}
		att, err := hd.SaveUpload(ctx, d.Storage, d.DB.Pool, hd.Upload{WorkspaceID: p.WorkspaceID, UploadedBy: p.ActorUserID(), UploadedByAPIKey: p.ActorAPIKeyID(),
			Filename: a.Name, Size: size, Body: bytes.NewReader(a.Data), Imported: true})
		var he *httpx.Error
		switch {
		case errors.As(err, &he) && he.Status < 500:
			reason := "unreadable"
			switch he.Code {
			case "file_type_refused":
				reason = "executable"
			case "too_large":
				reason = "too_large"
			}
			skips = append(skips, wikiport.Skip{Path: a.Key, Reason: reason})
			continue
		case err != nil:
			return nil, stored, nil, err
		}
		used += att.SizeBytes
		stored = append(stored, storedFile{id: att.ID, key: "workspaces/" + p.WorkspaceID.String() + "/attachments/" + att.ID.String()})
		ids[a.Ref] = att.ID.String()
	}
	return ids, stored, skips, nil
}

// dropFiles removes the files of an import that made no pages.
func dropFiles(d *deps.Deps, wid uuid.UUID, files []storedFile) {
	if len(files) == 0 {
		return
	}
	ctx := context.Background()
	list := make([]uuid.UUID, len(files))
	for i, f := range files {
		list[i] = f.id
	}
	if _, err := d.DB.Pool.Exec(ctx, `DELETE FROM attachments WHERE workspace_id = $1 AND id = ANY($2) AND message_id IS NULL`, wid, list); err != nil {
		d.Log.Warn("wiki import: remove files", "err", err)
		return // the sweep of unattached uploads removes them
	}
	for _, f := range files {
		if err := d.Storage.Delete(ctx, f.key); err != nil {
			d.Log.Warn("wiki import: remove file object", "attachment_id", f.id, "err", err)
		}
	}
}

// importer creates an import's pages in one transaction.
type importer struct {
	ctx   context.Context
	tx    pgx.Tx
	p     *auth.Principal
	res   *wikiport.Result
	ids   map[string]string
	dest  importDest
	skips []wikiport.Skip
	// made are the pages created, parents first, with their bodies.
	made []madePage
}

type madePage struct {
	id                uuid.UUID
	title, icon, body string
	canvas            string // a canvas's JSON: the files of its cards become the page's too
}

// create makes pg under parent (a page of the import, or where it lands) and then its
// subpages. db is the parent's database when pg is one of its rows; at is pg's position among
// its siblings, or -1 for the end (the import's top pages, after what is there).
func (im *importer) create(pg *wikiport.Page, parent *uuid.UUID, db *Database, at int) (uuid.UUID, error) {
	ctx, tx, wid := im.ctx, im.tx, im.p.WorkspaceID
	id := uuid.MustParse(im.ids[pg.Ref])
	title := cleanTitle(pg.Title)
	icon, err := cleanIcon(pg.Icon)
	if err != nil {
		icon = ""
	}
	body, err := cleanBody(im.res.Resolve(pg.BodyHTML, im.ids))
	if err != nil {
		body = ""
		im.skips = append(im.skips, wikiport.Skip{Path: pg.Key, Reason: "body_too_large"})
	}
	kind := "page"
	var database *Database
	if pg.Database != nil {
		raw, err := json.Marshal(pg.Database)
		if err != nil {
			return id, err
		}
		next, err := cleanDatabase(raw, nil)
		if err != nil {
			// A table the wiki can't keep as a database: its rows stay as subpages.
			im.skips = append(im.skips, wikiport.Skip{Path: pg.Key, Reason: "unreadable"})
		} else {
			kind, database = "database", &next
		}
	}
	props := map[string]any{}
	if db != nil {
		props = im.rowValues(pg, *db)
		if !im.dest.template {
			if err := nextRowNumbers(ctx, tx, wid, *parent, db, props); err != nil {
				return id, err
			}
		}
	}
	position := at
	if at < 0 {
		position = 2147483647
	}
	var dbValue any
	if database != nil {
		dbValue = database
	}
	var canvas any
	var canvasRaw string
	if pg.Canvas != nil {
		kind = "canvas"
		c := emptyCanvas()
		raw, err := json.Marshal(im.res.ResolveCanvas(pg.Canvas, im.ids))
		if err == nil {
			c, err = cleanCanvas(raw)
		}
		if err != nil {
			// wikiport keeps a canvas within the wiki's rules; one it missed is made empty.
			c = emptyCanvas()
			im.skips = append(im.skips, wikiport.Skip{Path: pg.Key, Reason: "unreadable"})
		}
		canvas = c
		if raw, err := json.Marshal(c); err == nil {
			canvasRaw = string(raw)
		}
	}
	// Each page is created a moment after the one before: what orders by creation (rows' unique
	// ids) follows the import's order.
	if _, err := tx.Exec(ctx, `INSERT INTO wiki_pages (id, workspace_id, parent_id, title, icon, body_html, position, created_by, updated_by, private_to, team_id, template, kind, database, props, canvas, created_at, updated_at, aliases, area)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15, clock_timestamp(), clock_timestamp(), $16, $17)`, id, wid, parent, title, icon, body, position, im.p.ActorUserID(),
		im.dest.owner, im.dest.team, im.dest.template, kind, dbValue, props, canvas, importAliases(pg.Aliases), im.dest.area); err != nil {
		return id, err
	}
	if at < 0 {
		if err := place(ctx, tx, wid, im.dest.area, parent, im.dest.owner, im.dest.team, im.dest.template, &id, nil); err != nil {
			return id, err
		}
	}
	im.made = append(im.made, madePage{id: id, title: title, icon: icon, body: body, canvas: canvasRaw})
	for i, c := range pg.Children {
		if _, err := im.create(c, &id, database, i); err != nil {
			return id, err
		}
	}
	return id, nil
}

// rowValues are a row's values the database takes, each checked as the API checks a row's
// values; one it refuses is left out.
func (im *importer) rowValues(pg *wikiport.Page, db Database) map[string]any {
	props := map[string]any{}
	for k, val := range pg.Props {
		raw, err := json.Marshal(map[string]any{k: val})
		if err != nil {
			continue
		}
		next, refs, err := cleanProps(raw, db, props)
		if err != nil || len(refs.users) > 0 || len(refs.tickets) > 0 || len(refs.pages) > 0 {
			continue
		}
		props = next
	}
	return props
}

// finish does what follows saving each body, once every page exists (bodies link forward and
// back): history, links and tags, the pages' files, following, reminders. Mentions tell
// nobody: an import is not someone writing to them. Then each page is announced, parents
// first, to those who may see it.
func (im *importer) finish() error {
	ctx, tx, p := im.ctx, im.tx, im.p
	list := make([]uuid.UUID, len(im.made))
	for i, m := range im.made {
		list[i] = m.id
		if err := recordRevision(ctx, tx, p, m.id, m.title, m.icon, m.body, false); err != nil {
			return err
		}
		if err := indexBody(ctx, tx, p.WorkspaceID, m.id, m.body); err != nil {
			return err
		}
		if err := autoFollow(ctx, tx, p, m.id); err != nil {
			return err
		}
		if err := bodySaved(ctx, tx, p, m.id, m.body, m.body); err != nil {
			return err
		}
		if err := claimFiles(ctx, tx, p, m.id, m.canvas); err != nil {
			return err
		}
	}
	nodes, err := collectNodes(tx.Query(ctx, nodeSelect+` WHERE p.workspace_id = $1 AND p.id = ANY($2)`, p.WorkspaceID, list))
	if err != nil {
		return err
	}
	byID := make(map[uuid.UUID]WikiNode, len(nodes))
	for _, n := range nodes {
		byID[n.ID] = n
	}
	var by *domain.UserRef
	if me := p.ActorUserID(); me != nil {
		ref, err := domain.LoadUserRef(ctx, tx, *me)
		if err != nil {
			return err
		}
		by = &ref
	}
	scope := WikiPage{owner: im.dest.owner}
	scope.TeamID = im.dest.team
	for _, id := range list {
		if err := pageEvent(ctx, tx, p.WorkspaceID, scope, "wiki_page.created", map[string]any{"wiki_page": byID[id], "updated_by": by}); err != nil {
			return err
		}
	}
	return nil
}

// --- export -----------------------------------------------------------------------------

// exportCols are what an export reads of a page aliased p.
const exportCols = `p.id, p.parent_id, p.title, p.icon, p.body_html, p.kind, p.database, p.props, p.tags, p.created_at, p.updated_at, p.canvas, p.aliases`

func scanExport(rows pgx.Rows, err error) ([]wikiport.ExportPage, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []wikiport.ExportPage
	total := 0
	for rows.Next() {
		var pg wikiport.ExportPage
		var id uuid.UUID
		var parent *uuid.UUID
		var database, canvas []byte
		if err := rows.Scan(&id, &parent, &pg.Title, &pg.Icon, &pg.BodyHTML, &pg.Kind, &database, &pg.Props, &pg.Tags, &pg.CreatedAt, &pg.UpdatedAt, &canvas, &pg.Aliases); err != nil {
			return nil, err
		}
		if total += len(pg.BodyHTML); total > maxExportText {
			return nil, httpx.E(http.StatusUnprocessableEntity, "export_too_large", "These pages hold more than 200 MB of text. Export a part of the wiki at a time.")
		}
		pg.ID = id.String()
		if parent != nil {
			pg.ParentID = parent.String()
		}
		if err := exportData(&pg, database, canvas); err != nil {
			return nil, err
		}
		out = append(out, pg)
	}
	return out, rows.Err()
}

// exportData reads a database's schema and a canvas's cards into an exported page; wikiport's
// Canvas is the stored canvas's JSON.
func exportData(pg *wikiport.ExportPage, database, canvas []byte) error {
	if database != nil {
		pg.Database = new(wikiport.Database)
		if err := json.Unmarshal(database, pg.Database); err != nil {
			return err
		}
	}
	if canvas != nil {
		pg.Canvas = new(wikiport.Canvas)
		if err := json.Unmarshal(canvas, pg.Canvas); err != nil {
			return err
		}
	}
	return nil
}

type rootPage struct {
	page     wikiport.ExportPage
	template bool
}

// exportRoot is the page an export starts from: one the viewer may see, not in the trash.
func exportRoot(ctx context.Context, q db.Querier, v Viewer, wid, id uuid.UUID) (rootPage, error) {
	me, hidden := v.args()
	rows, err := q.Query(ctx, `SELECT `+exportCols+`, p.template FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2
		AND p.deleted_at IS NULL AND `+seesSQL("p", 3, 4), wid, id, me, hidden)
	if err != nil {
		return rootPage{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return rootPage{}, err
		}
		return rootPage{}, httpx.NotFound("Page")
	}
	var r rootPage
	var parent *uuid.UUID
	var database, canvas []byte
	pg := &r.page
	var pid uuid.UUID
	if err := rows.Scan(&pid, &parent, &pg.Title, &pg.Icon, &pg.BodyHTML, &pg.Kind, &database, &pg.Props, &pg.Tags, &pg.CreatedAt, &pg.UpdatedAt, &canvas, &pg.Aliases, &r.template); err != nil {
		return rootPage{}, err
	}
	pg.ID = pid.String()
	if err := exportData(pg, database, canvas); err != nil {
		return rootPage{}, err
	}
	return r, rows.Err()
}

// subtreePages are id and the pages under it the viewer may see, not in the trash, parents
// first and siblings in order. A page out of sight hides what is under it.
func subtreePages(ctx context.Context, q db.Querier, v Viewer, wid, id uuid.UUID, template bool) ([]wikiport.ExportPage, error) {
	me, hidden := v.args()
	out, err := scanExport(q.Query(ctx, `WITH RECURSIVE down(id, depth) AS (
			SELECT p.id, 1 FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2
			UNION ALL
			SELECT p.id, down.depth + 1 FROM wiki_pages p JOIN down ON p.parent_id = down.id
			WHERE p.workspace_id = $1 AND down.depth < 64 AND p.deleted_at IS NULL AND p.template = $5 AND `+seesSQL("p", 3, 4)+`
		)
		SELECT `+exportCols+` FROM wiki_pages p JOIN down ON down.id = p.id WHERE p.workspace_id = $1
		ORDER BY down.depth, p.parent_id, p.position, p.id`, wid, id, me, hidden, template))
	if err == nil && len(out) > 0 {
		out[0].ParentID = ""
	}
	return out, err
}

// treePages are the pages of the viewer's tree (contracts/wiki.md "Access"): the workspace's,
// the teamspaces they may see, their own; siblings in order.
func treePages(ctx context.Context, q db.Querier, v Viewer, wid uuid.UUID, area string) ([]wikiport.ExportPage, error) {
	me, hidden := v.args()
	return scanExport(q.Query(ctx, `SELECT `+exportCols+` FROM wiki_pages p WHERE p.workspace_id = $1 AND p.area = $4 AND `+liveSQL("p", 2, 3)+`
		ORDER BY p.private_to IS NOT NULL, p.team_id NULLS FIRST, p.parent_id NULLS FIRST, p.position, p.id`, wid, me, hidden, area))
}

// export writes pages for a caller.
type export struct {
	d      *deps.Deps
	p      *auth.Principal
	v      Viewer
	format wikiport.Format
}

func newExport(d *deps.Deps, p *auth.Principal, v Viewer, format wikiport.Format) *export {
	if format == "" {
		format = wikiport.FormatMarkdown
	}
	return &export{d: d, p: p, v: v, format: format}
}

func (e *export) options() wikiport.ExportOptions {
	return wikiport.ExportOptions{Format: e.format, Frontmatter: e.format == wikiport.FormatMarkdown, BaseURL: e.d.Cfg.AppURL}
}

// prepare names files by their plain path, which the export carries or links to the app.
func prepare(pages []wikiport.ExportPage) {
	for i := range pages {
		plainPage(&pages[i])
	}
}

// plainPage names a page's files by their plain path: in its body, and in a canvas's text
// cards and file cards.
func plainPage(pg *wikiport.ExportPage) {
	pg.BodyHTML = hd.PlainFiles(pg.BodyHTML)
	if pg.Canvas == nil {
		return
	}
	for i := range pg.Canvas.Nodes {
		n := &pg.Canvas.Nodes[i]
		n.HTML = hd.PlainFiles(n.HTML)
		if m := attachmentSrc.FindStringSubmatch(n.Src); m != nil {
			n.Src = "/v1/attachments/" + m[1]
		}
	}
}

// contentType is a single file's type, by its name.
func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".canvas":
		return "application/json; charset=utf-8"
	}
	return "text/markdown; charset=utf-8"
}

// download sets a download's headers: never shown or sniffed by a browser, never stored.
func download(ctx huma.Context, contentType, name string) {
	ctx.SetHeader("Content-Type", contentType)
	ctx.SetHeader("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	ctx.SetHeader("X-Content-Type-Options", "nosniff")
	ctx.SetHeader("Content-Security-Policy", "default-src 'none'; sandbox")
	ctx.SetHeader("Cache-Control", "private, no-store")
}

// file answers one page as one file: its links and files point to the app.
func (e *export) file(pg wikiport.ExportPage) (*huma.StreamResponse, error) {
	plainPage(&pg)
	var buf bytes.Buffer
	if err := wikiport.ExportFile(&buf, pg, e.options()); err != nil {
		return nil, httpx.Wrap(err)
	}
	name := wikiport.ExportFileName(pg, e.format)
	return &huma.StreamResponse{Body: func(ctx huma.Context) {
		download(ctx, contentType(name), name)
		ctx.SetStatus(http.StatusOK)
		_, _ = ctx.BodyWriter().Write(buf.Bytes())
	}}, nil
}

// zip streams pages as a zip with the files they use that the caller may read, up to
// maxExportFiles; it is audited, as a copy of the wiki leaving it.
func (e *export) zip(ctx context.Context, name string, pages []wikiport.ExportPage, root *uuid.UUID) (*huma.StreamResponse, error) {
	key := "wiki:export:"
	if me := e.p.ActorUserID(); me != nil {
		key += me.String()
	} else {
		key += e.p.APIKeyID.String()
	}
	if !e.d.Limiter.Allow(key, exportsPerHour, time.Hour) {
		return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Too many exports. Try again later.")
	}
	if err := e.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		return audit.Log(ctx, tx, e.p, e.p.WorkspaceID, "wiki.exported", "wiki_page", root, map[string]any{"pages": len(pages), "format": string(e.format)})
	}); err != nil {
		return nil, httpx.Wrap(err)
	}
	prepare(pages)
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		if _, w := humachi.Unwrap(hctx); w != nil {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(portDeadline))
		}
		download(hctx, "application/zip", name)
		hctx.SetStatus(http.StatusOK)
		opt := e.options()
		opt.Attachment = e.files(hctx.Context())
		if err := wikiport.ExportZip(hctx.BodyWriter(), pages, opt); err != nil {
			e.d.Log.Error("wiki export", "err", err, "request_id", httpx.RequestIDFrom(hctx.Context()))
		}
	}}, nil
}

// files opens a file a page uses for the zip: one of the workspace's that the caller may
// read as GET /v1/attachments/{id} lets them (a page's file of a page they may see, or their
// own upload not sent yet), until the zip holds maxExportFiles. Any other stays a link.
func (e *export) files(ctx context.Context) func(string) (string, io.ReadCloser, error) {
	var used int64
	me, hidden := e.v.args()
	return func(raw string) (string, io.ReadCloser, error) {
		id, err := uuid.Parse(raw)
		if err != nil {
			return "", nil, err
		}
		var name, key string
		var size int64
		err = e.d.DB.Pool.QueryRow(ctx, `SELECT a.filename, a.storage_key, a.size_bytes FROM attachments a
			LEFT JOIN wiki_pages p ON p.workspace_id = a.workspace_id AND p.id = a.wiki_page_id
			WHERE a.workspace_id = $1 AND a.id = $2 AND a.message_id IS NULL
			AND ((p.id IS NOT NULL AND `+seesSQL("p", 3, 4)+`)
				OR (a.wiki_page_id IS NULL AND (a.uploaded_by = $5 OR a.uploaded_by_api_key_id = $6)))`,
			e.p.WorkspaceID, id, me, hidden, e.p.ActorUserID(), e.p.ActorAPIKeyID()).Scan(&name, &key, &size)
		if err != nil {
			return "", nil, err
		}
		if used+size > maxExportFiles {
			return "", nil, errors.New("wiki export: files over the limit")
		}
		used += size
		body, err := e.d.Storage.Get(ctx, key)
		return name, body, err
	}
}

// importAliases are a source's aliases as the wiki keeps them: those over 100 characters
// left out, then the first 10.
func importAliases(raw []string) []string {
	var keep []string
	for _, a := range raw {
		if one, err := cleanAliases([]string{a}); err == nil && len(one) == 1 {
			keep = append(keep, one[0])
		}
	}
	for {
		out, err := cleanAliases(keep)
		if err == nil {
			return out
		}
		keep = keep[:len(keep)-1]
	}
}
