package kb

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

type changelogEntryCreate struct {
	Title       string     `json:"title" minLength:"1" maxLength:"200"`
	Slug        string     `json:"slug,omitempty" maxLength:"100"`
	BodyHTML    string     `json:"body_html,omitempty" maxLength:"200000"`
	Excerpt     *string    `json:"excerpt,omitempty" maxLength:"2000" doc:"Plain text; derived from the body when empty"`
	Categories  []string   `json:"categories,omitempty" maxItems:"20" doc:"Up to 5 names of up to 32 characters"`
	Status      string     `json:"status,omitempty" enum:"draft,published" default:"draft"`
	PublishedAt *time.Time `json:"published_at,omitempty" required:"false" nullable:"true" doc:"The date it carries; set when first published when absent. A future date on a published entry schedules it"`
	BrandID     *string    `json:"brand_id,omitempty" required:"false" nullable:"true" doc:"Brand id, or null for every brand"`
}

type changelogEntryPatch struct {
	Title       *string                `json:"title,omitempty" minLength:"1" maxLength:"200"`
	Slug        *string                `json:"slug,omitempty" maxLength:"100"`
	BodyHTML    *string                `json:"body_html,omitempty" maxLength:"200000"`
	Excerpt     *string                `json:"excerpt,omitempty" maxLength:"2000" doc:"Plain text; empty derives it from the body"`
	Categories  *[]string              `json:"categories,omitempty" maxItems:"20" doc:"Replaces the categories: up to 5 names of up to 32 characters"`
	Status      *string                `json:"status,omitempty" enum:"draft,published"`
	PublishedAt hd.Nullable[time.Time] `json:"published_at,omitempty" doc:"The date it carries; null dates it when it is next published"`
	BrandID     hd.Nullable[string]    `json:"brand_id,omitempty" doc:"Brand id, or null for every brand"`
}

type entryOut struct{ Body ChangelogEntry }

type entryCursor struct {
	K time.Time `json:"k"`
	I uuid.UUID `json:"i"`
}

type changelogCategory struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// entrySort is the agent list's order: the date an entry carries, else when it last changed.
const entrySort = `COALESCE(e.published_at, e.updated_at)`

func registerChangelog(d *deps.Deps, api huma.API) {
	tags := []string{"Changelog"}

	huma.Register(api, huma.Operation{OperationID: "list-changelog-entries", Method: http.MethodGet, Path: "/v1/changelog/entries",
		Summary: "List changelog entries", Description: "Newest first. With q, returns the best matches by rank (no further pages).", Tags: tags},
		func(ctx context.Context, in *struct {
			httpx.ListParams
			Status     string `query:"status" enum:"draft,published,scheduled" doc:"published: live now; scheduled: published with a future date"`
			Category   string `query:"category" maxLength:"64" doc:"Only entries with this category, compared without case"`
			BrandID    string `query:"brand_id" doc:"Only this brand's entries; \"none\" for those of every brand"`
			ForBrandID string `query:"for_brand_id" doc:"What this brand's help center shows: its own entries and those of every brand"`
			Q          string `query:"q" maxLength:"200"`
		}) (*struct{ Body httpx.Page[ChangelogEntry] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeChangelogRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			limit := in.Limit
			if limit <= 0 || limit > 100 {
				limit = 50
			}
			where := []string{"e.workspace_id = $1"}
			args := []any{p.WorkspaceID}
			arg := func(v any) string {
				args = append(args, v)
				return "$" + itoaArg(len(args))
			}
			switch in.Status {
			case "draft":
				where = append(where, "e.status = 'draft'")
			case "published":
				where = append(where, "e.status = 'published' AND e.published_at <= now()")
			case "scheduled":
				where = append(where, "e.status = 'published' AND e.published_at > now()")
			}
			if c := strings.TrimSpace(in.Category); c != "" {
				arg(c)
				where = append(where, categoryMatch(len(args)))
			}
			bf, err := brandFilter(in.BrandID, "e.brand_id", arg)
			if err != nil {
				return nil, err
			}
			if bf != "" {
				where = append(where, bf)
			}
			if strings.TrimSpace(in.ForBrandID) != "" {
				bid, err := hd.ParseRef(in.ForBrandID, "for_brand_id")
				if err != nil {
					return nil, err
				}
				b := arg(bid)
				where = append(where, "COALESCE(e.brand_id, "+b+") = "+b)
			}
			if q := strings.TrimSpace(in.Q); q != "" {
				pq := prefixQuery(q)
				if pq == "" {
					return &struct{ Body httpx.Page[ChangelogEntry] }{httpx.Page[ChangelogEntry]{Data: []ChangelogEntry{}}}, nil
				}
				args = append(args, q, pq)
				tsq := searchQuery(len(args) - 1)
				rows, err := d.DB.Pool.Query(ctx, entrySelect+` WHERE `+strings.Join(where, " AND ")+` AND e.search @@ `+tsq+
					` ORDER BY ts_rank(e.search, `+tsq+`) DESC, `+entrySort+` DESC, e.id LIMIT `+arg(limit), args...)
				out, err := collectRows(rows, err, scanEntry)
				if err != nil {
					return nil, httpx.Wrap(err)
				}
				return &struct{ Body httpx.Page[ChangelogEntry] }{httpx.Page[ChangelogEntry]{Data: out}}, nil
			}
			var cur entryCursor
			if err := httpx.DecodeCursor(in.Cursor, &cur); err != nil {
				return nil, err
			}
			if in.Cursor != "" {
				where = append(where, "("+entrySort+", e.id) < ("+arg(cur.K)+", "+arg(cur.I)+")")
			}
			rows, err := d.DB.Pool.Query(ctx, entrySelect+` WHERE `+strings.Join(where, " AND ")+` ORDER BY `+entrySort+` DESC, e.id DESC LIMIT `+arg(limit+1), args...)
			out, err := collectRows(rows, err, scanEntry)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[ChangelogEntry] }{httpx.NewPage(out, limit, func(e ChangelogEntry) any {
				k := e.UpdatedAt
				if e.PublishedAt != nil {
					k = *e.PublishedAt
				}
				return entryCursor{K: k, I: e.ID}
			})}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "list-changelog-categories", Method: http.MethodGet, Path: "/v1/changelog/categories",
		Summary: "List changelog categories", Description: "The categories the workspace's entries use, most used first.", Tags: tags},
		func(ctx context.Context, _ *struct{}) (*struct{ Body []changelogCategory }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeChangelogRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, `SELECT mode() WITHIN GROUP (ORDER BY c), count(*) FROM changelog_entries e, unnest(e.categories) c
				WHERE e.workspace_id = $1 GROUP BY lower(c) ORDER BY count(*) DESC, 1 LIMIT 100`, p.WorkspaceID)
			out, err := collectRows(rows, err, func(r pgx.Row) (changelogCategory, error) {
				var c changelogCategory
				return c, r.Scan(&c.Name, &c.Count)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body []changelogCategory }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-changelog-entry", Method: http.MethodGet, Path: "/v1/changelog/entries/{id}",
		Summary: "Get a changelog entry", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*entryOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeChangelogRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Changelog entry")
			if err != nil {
				return nil, err
			}
			e, err := loadEntry(ctx, d.DB.Pool, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Changelog entry")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &entryOut{e}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "create-changelog-entry", Method: http.MethodPost, Path: "/v1/changelog/entries",
		Summary: "Create a changelog entry", Tags: tags, DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct{ Body changelogEntryCreate }) (*entryOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeChangelogWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			title, err := cleanTitle(b.Title)
			if err != nil {
				return nil, err
			}
			cats, err := cleanCategories(b.Categories)
			if err != nil {
				return nil, err
			}
			status := b.Status
			if status == "" {
				status = "draft"
			}
			body := hd.SanitizeRich(b.BodyHTML)
			excerpt := ""
			if b.Excerpt != nil {
				excerpt = cleanExcerpt(*b.Excerpt)
			}
			if excerpt == "" {
				excerpt = deriveExcerpt(body)
			}
			var e ChangelogEntry
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var brand *uuid.UUID
				if b.BrandID != nil {
					if brand, err = brandRef(ctx, tx, p.WorkspaceID, *b.BrandID); err != nil {
						return err
					}
				}
				slug, err := pickSlug(ctx, tx, "changelog_entries", p.WorkspaceID, &b.Slug, title, nil)
				if err != nil {
					return err
				}
				id := ids.New()
				if _, err := tx.Exec(ctx, `INSERT INTO changelog_entries (id, workspace_id, brand_id, title, slug, excerpt, body_html, categories,
					status, author_id, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, CASE WHEN $9 = 'published' THEN now() END))`,
					id, p.WorkspaceID, brand, title, slug, excerpt, body, cats, status, p.ActorUserID(), b.PublishedAt); err != nil {
					return slugConflict(err)
				}
				if e, err = loadEntry(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "changelog_entry.created", Data: map[string]any{"changelog_entry": e}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &entryOut{e}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-changelog-entry", Method: http.MethodPatch, Path: "/v1/changelog/entries/{id}",
		Summary: "Update a changelog entry", Tags: tags},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body changelogEntryPatch
		}) (*entryOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeChangelogWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Changelog entry")
			if err != nil {
				return nil, err
			}
			b := in.Body
			var e ChangelogEntry
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				cur, err := scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.workspace_id = $1 AND e.id = $2 FOR UPDATE OF e`, p.WorkspaceID, id))
				if db.IsNotFound(err) {
					return httpx.NotFound("Changelog entry")
				}
				if err != nil {
					return err
				}
				if b.Title != nil {
					if cur.Title, err = cleanTitle(*b.Title); err != nil {
						return err
					}
				}
				if b.Slug != nil {
					if cur.Slug, err = pickSlug(ctx, tx, "changelog_entries", p.WorkspaceID, b.Slug, cur.Title, &id); err != nil {
						return err
					}
				}
				if b.Categories != nil {
					if cur.Categories, err = cleanCategories(*b.Categories); err != nil {
						return err
					}
				}
				// A derived excerpt follows the body; one written by hand stays until replaced.
				wasDerived := cur.Excerpt == deriveExcerpt(cur.BodyHTML)
				if b.BodyHTML != nil {
					cur.BodyHTML = hd.SanitizeRich(*b.BodyHTML)
				}
				switch {
				case b.Excerpt != nil:
					if cur.Excerpt = cleanExcerpt(*b.Excerpt); cur.Excerpt == "" {
						cur.Excerpt = deriveExcerpt(cur.BodyHTML)
					}
				case b.BodyHTML != nil && wasDerived:
					cur.Excerpt = deriveExcerpt(cur.BodyHTML)
				}
				if b.Status != nil {
					cur.Status = *b.Status
				}
				if b.PublishedAt.Set {
					cur.PublishedAt = b.PublishedAt.Ptr()
				}
				if b.BrandID.Set {
					cur.BrandID = nil
					if !b.BrandID.Null {
						if cur.BrandID, err = brandRef(ctx, tx, p.WorkspaceID, b.BrandID.Value); err != nil {
							return err
						}
					}
				}
				// An entry without a date takes the moment it is published; unpublishing keeps it.
				if _, err := tx.Exec(ctx, `UPDATE changelog_entries SET title = $3, slug = $4, excerpt = $5, body_html = $6, categories = $7,
					status = $8, brand_id = $9, updated_at = now(),
					published_at = COALESCE($10, CASE WHEN $8 = 'published' THEN now() END)
					WHERE workspace_id = $1 AND id = $2`,
					p.WorkspaceID, id, cur.Title, cur.Slug, cur.Excerpt, cur.BodyHTML, cur.Categories, cur.Status, cur.BrandID, cur.PublishedAt); err != nil {
					return slugConflict(err)
				}
				if e, err = loadEntry(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "changelog_entry.updated", Data: map[string]any{"changelog_entry": e}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &entryOut{e}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-changelog-entry", Method: http.MethodDelete, Path: "/v1/changelog/entries/{id}",
		Summary: "Delete a changelog entry", Tags: tags, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*hd.Empty, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeChangelogWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Changelog entry")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				tag, err := tx.Exec(ctx, `DELETE FROM changelog_entries WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if tag.RowsAffected() == 0 {
					return httpx.NotFound("Changelog entry")
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "changelog_entry.deleted", Data: map[string]any{"changelog_entry_id": id}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}

type changelogCursor struct {
	P time.Time `json:"p"`
	I uuid.UUID `json:"i"`
}

func registerPublicChangelog(d *deps.Deps, api huma.API, limited huma.Middlewares, public1 []map[string][]string) {
	tags := []string{"Help center"}

	huma.Register(api, huma.Operation{OperationID: "public-help-changelog", Method: http.MethodGet,
		Path: "/v1/public/help/{workspace_slug}/changelog", Summary: "Help center changelog",
		Description: "Published entries dated now or earlier, newest first.", Tags: tags, Security: public1, Middlewares: limited},
		func(ctx context.Context, in *struct {
			WSSlug   string `path:"workspace_slug"`
			Category string `query:"category" maxLength:"64"`
			Limit    int    `query:"limit" minimum:"1" maximum:"50" default:"20" doc:"Page size"`
			Cursor   string `query:"cursor" doc:"Opaque cursor from next_cursor"`
		}) (*struct{ Body httpx.Page[ChangelogEntry] }, error) {
			hc, err := helpCenter(ctx, d, in.WSSlug)
			if err != nil {
				return nil, err
			}
			limit := in.Limit
			if limit <= 0 || limit > 50 {
				limit = changelogPublic
			}
			args := []any{hc.WorkspaceID, hc.BrandID}
			where := changelogVisible(2)
			if c := strings.TrimSpace(in.Category); c != "" {
				args = append(args, c)
				where += ` AND ` + categoryMatch(len(args))
			}
			var cur changelogCursor
			if err := httpx.DecodeCursor(in.Cursor, &cur); err != nil {
				return nil, err
			}
			if in.Cursor != "" {
				args = append(args, cur.P, cur.I)
				where += ` AND (e.published_at, e.id) < ($` + itoaArg(len(args)-1) + `, $` + itoaArg(len(args)) + `)`
			}
			args = append(args, limit+1)
			rows, err := d.DB.Pool.Query(ctx, entrySelect+` WHERE `+where+` ORDER BY e.published_at DESC, e.id DESC LIMIT $`+itoaArg(len(args)), args...)
			out, err := collectRows(rows, err, scanEntry)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			for i := range out {
				out[i] = publicEntry(out[i])
			}
			return &struct{ Body httpx.Page[ChangelogEntry] }{httpx.NewPage(out, limit, func(e ChangelogEntry) any {
				return changelogCursor{P: *e.PublishedAt, I: e.ID}
			})}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "public-help-changelog-entry", Method: http.MethodGet,
		Path: "/v1/public/help/{workspace_slug}/changelog/{slug}", Summary: "Help center changelog entry", Tags: tags,
		Security: public1, Middlewares: limited},
		func(ctx context.Context, in *struct {
			WSSlug string `path:"workspace_slug"`
			Slug   string `path:"slug"`
		}) (*entryOut, error) {
			hc, err := helpCenter(ctx, d, in.WSSlug)
			if err != nil {
				return nil, err
			}
			e, err := ChangelogEntryBySlug(ctx, d.DB.Pool, hc, in.Slug)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Changelog entry")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &entryOut{e}, nil
		})
}
