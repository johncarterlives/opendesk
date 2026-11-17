package wiki

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/products"
)

// Limits (contracts/wiki.md "Limits").
const (
	maxTitle     = 200
	maxBodyBytes = 512 << 10
	maxDepth     = 10
	maxPages     = 5000
	maxRevisions = 100
	// One author's edits less than coalesceGap apart share a revision, for at most coalesceSpan.
	coalesceGap  = 10 * time.Minute
	coalesceSpan = time.Hour
	// Pages stay in the trash this long, then go for good.
	trashKeep = 30 * 24 * time.Hour
)

// Areas are whose tree a page is in (contracts/pages.md): the wiki's, or Pages', the
// product of the workspace's own pages beside it. A subpage is in its parent's area.
const (
	AreaWiki  = "wiki"
	AreaPages = "pages"
)

// Space is where a page lives (contracts/wiki.md "Private pages and teamspaces"): shared
// with the workspace, a member's own, or a team's. Subpages live where their top page does.
type Space struct {
	Private bool       `json:"private" doc:"The page is yours alone: nobody else sees it, admins included"`
	TeamID  *uuid.UUID `json:"team_id" doc:"The teamspace it is in; a private team's pages show to its members only"`
}

// WikiNode is a page in the tree: everything but its body.
type WikiNode struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id" doc:"The page it sits under; null at the top level"`
	Title     string     `json:"title" doc:"Empty until named; shown as Untitled"`
	Icon      string     `json:"icon" doc:"An emoji, or empty"`
	Position  int        `json:"position" doc:"Order among its siblings, from 0"`
	Version   int        `json:"version" doc:"Moves on every change of title, icon or body"`
	UpdatedAt time.Time  `json:"updated_at"`
	CreatedBy *uuid.UUID `json:"created_by_id" doc:"Who created it; null for an API key or a deleted account"`
	Tags      []string   `json:"tags" doc:"The #tags in its text, lower case"`
	Space
	Journal   bool    `json:"journal,omitempty" doc:"The member's journal: their daily notes are under it"`
	DailyDate *string `json:"daily_date,omitempty" doc:"The day of a daily note, YYYY-MM-DD"`
	Template  bool    `json:"template,omitempty" doc:"A template (or a page of one): copied into new pages, never in the tree"`
	Verified  bool    `json:"verified,omitempty" doc:"Verified, and not past the day it was verified until"`
	Kind      string  `json:"kind" enum:"page,database,canvas" doc:"A database's subpages are its rows; a canvas holds cards"`
	Area      string  `json:"area" enum:"wiki,pages" doc:"Whose tree it is in: the wiki's or Pages' (contracts/pages.md)"`
	// Aliases are left out where a list reads only nodeCols (a database's rows, the trash).
	Aliases []string `json:"aliases,omitempty" doc:"Other names the page goes by (contracts/wiki.md \"Aliases\")"`
}

// WikiRef names a page: breadcrumbs, subpages, search paths.
type WikiRef struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
	Icon  string    `json:"icon"`
}

// PageSettings is a page's own look (contracts/wiki.md "Page settings"): never part of its
// text, so changing one keeps the version and adds no revision.
type PageSettings struct {
	Cover     string `json:"cover" doc:"\"\" (none), gradient:<name>, or an image: https or one of our attachments"`
	CoverY    int    `json:"cover_y" minimum:"0" maximum:"100" doc:"Which part of the cover shows, from the top (0) to the bottom (100)"`
	FullWidth bool   `json:"full_width"`
	SmallText bool   `json:"small_text"`
	Font      string `json:"font" enum:"default,serif,mono"`
	Locked    bool   `json:"locked" doc:"The app keeps the page read-only until someone unlocks it"`
}

// Verification says who vouched for a page and until when (contracts/wiki.md "Verified pages").
type Verification struct {
	By      *domain.UserRef `json:"by"`
	At      time.Time       `json:"at"`
	Until   *time.Time      `json:"until" doc:"Null: verified until someone changes it"`
	Expired bool            `json:"expired"`
}

// WikiPage is one page with its body, from contracts/wiki.md.
type WikiPage struct {
	PageSettings
	Space
	ID           uuid.UUID       `json:"id"`
	ParentID     *uuid.UUID      `json:"parent_id"`
	Title        string          `json:"title"`
	Icon         string          `json:"icon"`
	BodyHTML     string          `json:"body_html"`
	Position     int             `json:"position"`
	Version      int             `json:"version"`
	Tags         []string        `json:"tags"`
	Aliases      []string        `json:"aliases" doc:"Other names the page goes by: links, page search and unlinked mentions find it by them"`
	Template     bool            `json:"template"`
	Kind         string          `json:"kind" enum:"page,database,canvas"`
	Area         string          `json:"area" enum:"wiki,pages" doc:"Whose tree it is in: the wiki's or Pages' (contracts/pages.md)"`
	Database     *Database       `json:"database" doc:"A database's properties and views; null for a page"`
	Props        map[string]any  `json:"props" doc:"A database row's values, by property id"`
	Canvas       *Canvas         `json:"canvas" doc:"A canvas's cards and connections; null for a page"`
	Journal      bool            `json:"journal"`
	DailyDate    *string         `json:"daily_date"`
	Verification *Verification   `json:"verification"`
	DeletedAt    *time.Time      `json:"deleted_at" doc:"In the trash since; null for a page in the tree"`
	DeletedBy    *domain.UserRef `json:"deleted_by"`
	CreatedBy    *domain.UserRef `json:"created_by"`
	UpdatedBy    *domain.UserRef `json:"updated_by"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
	Breadcrumbs  []WikiRef       `json:"breadcrumbs" doc:"Its ancestors, the top-level page first"`
	Children     []WikiRef       `json:"children" doc:"Its subpages, in order"`

	// owner is the private page's member, for scoping its events.
	owner *uuid.UUID
}

func (p WikiPage) node() WikiNode {
	n := WikiNode{ID: p.ID, ParentID: p.ParentID, Title: p.Title, Icon: p.Icon, Position: p.Position, Version: p.Version, UpdatedAt: p.UpdatedAt,
		Tags: p.Tags, Space: p.Space, Journal: p.Journal, DailyDate: p.DailyDate, Template: p.Template, Verified: p.Verification != nil && !p.Verification.Expired, Kind: p.Kind, Area: p.Area, Aliases: p.Aliases}
	if p.CreatedBy != nil {
		n.CreatedBy = &p.CreatedBy.ID
	}
	return n
}

// nodeCols are a node's columns of wiki_pages aliased p; nodeSelect adds its aliases,
// and scanNode reads both.
const nodeCols = `p.id, p.parent_id, p.title, p.icon, p.position, p.version, p.updated_at, p.created_by, p.tags,
	p.private_to IS NOT NULL, p.team_id, p.journal, to_char(p.daily_date, 'YYYY-MM-DD'), p.template,
	p.verified_at IS NOT NULL AND (p.verified_until IS NULL OR p.verified_until > now()), p.kind, p.area`

const nodeSelect = `SELECT ` + nodeCols + `, p.aliases FROM wiki_pages p`

func scanNode(row pgx.Row) (WikiNode, error) {
	var n WikiNode
	err := row.Scan(&n.ID, &n.ParentID, &n.Title, &n.Icon, &n.Position, &n.Version, &n.UpdatedAt, &n.CreatedBy, &n.Tags,
		&n.Private, &n.TeamID, &n.Journal, &n.DailyDate, &n.Template, &n.Verified, &n.Kind, &n.Area, &n.Aliases)
	return n, err
}

func collectNodes(rows pgx.Rows, err error) ([]WikiNode, error) {
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (WikiNode, error) { return scanNode(r) })
	if out == nil {
		out = []WikiNode{}
	}
	return out, err
}

const pageSelect = `SELECT p.id, p.parent_id, p.title, p.icon, p.body_html, p.position, p.version, p.created_at, p.updated_at,
	p.cover, p.cover_y, p.full_width, p.small_text, p.font, p.locked, p.tags,
	p.private_to, p.team_id, p.template, p.journal, to_char(p.daily_date, 'YYYY-MM-DD'), p.deleted_at, p.trashed_with,
	p.verified_at, p.verified_until, p.kind, p.database, p.props, p.canvas, p.aliases, p.area,
	c.id, c.name, c.email, c.avatar_url, u.id, u.name, u.email, u.avatar_url,
	v.id, v.name, v.email, v.avatar_url, x.id, x.name, x.email, x.avatar_url
FROM wiki_pages p LEFT JOIN users c ON c.id = p.created_by LEFT JOIN users u ON u.id = p.updated_by
	LEFT JOIN users v ON v.id = p.verified_by LEFT JOIN users x ON x.id = p.deleted_by`

// userCols receives a LEFT JOINed user.
type userCols struct {
	id                  *uuid.UUID
	name, email, avatar *string
}

func (u userCols) ref() *domain.UserRef {
	if u.id == nil {
		return nil
	}
	return &domain.UserRef{ID: *u.id, Name: deref(u.name), Email: deref(u.email), AvatarURL: domain.Avatar(deref(u.avatar))}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// loadPage reads a page of the workspace with its breadcrumbs and subpages, whoever may
// see it: callers check the viewer first (loadVisible).
func loadPage(ctx context.Context, q db.Querier, wid, id uuid.UUID) (WikiPage, error) {
	var p WikiPage
	var c, u, v, x userCols
	var trashedWith *uuid.UUID
	var verifiedAt, verifiedUntil *time.Time
	var database, canvas []byte
	err := q.QueryRow(ctx, pageSelect+` WHERE p.workspace_id = $1 AND p.id = $2`, wid, id).Scan(
		&p.ID, &p.ParentID, &p.Title, &p.Icon, &p.BodyHTML, &p.Position, &p.Version, &p.CreatedAt, &p.UpdatedAt,
		&p.Cover, &p.CoverY, &p.FullWidth, &p.SmallText, &p.Font, &p.Locked, &p.Tags,
		&p.owner, &p.TeamID, &p.Template, &p.Journal, &p.DailyDate, &p.DeletedAt, &trashedWith,
		&verifiedAt, &verifiedUntil, &p.Kind, &database, &p.Props, &canvas, &p.Aliases, &p.Area,
		&c.id, &c.name, &c.email, &c.avatar, &u.id, &u.name, &u.email, &u.avatar,
		&v.id, &v.name, &v.email, &v.avatar, &x.id, &x.name, &x.email, &x.avatar)
	if err != nil {
		return p, err
	}
	p.Private = p.owner != nil
	if database != nil {
		p.Database = new(Database)
		if err := json.Unmarshal(database, p.Database); err != nil {
			return p, err
		}
	}
	if p.Props == nil {
		p.Props = map[string]any{}
	}
	if p.Aliases == nil {
		p.Aliases = []string{}
	}
	if canvas != nil {
		p.Canvas = new(Canvas)
		if err := json.Unmarshal(canvas, p.Canvas); err != nil {
			return p, err
		}
	}
	if p.BodyHTML, err = signFiles(ctx, q, wid, id, p.BodyHTML); err != nil {
		return p, err
	}
	p.CreatedBy, p.UpdatedBy, p.DeletedBy = c.ref(), u.ref(), x.ref()
	if verifiedAt != nil {
		p.Verification = &Verification{By: v.ref(), At: *verifiedAt, Until: verifiedUntil, Expired: verifiedUntil != nil && verifiedUntil.Before(time.Now())}
	}
	if p.Breadcrumbs, err = ancestors(ctx, q, wid, id); err != nil {
		return p, err
	}
	// A page in the tree shows its subpages in the tree; one in the trash, those trashed with it.
	rows, err := q.Query(ctx, `SELECT id, title, icon FROM wiki_pages WHERE workspace_id = $1 AND parent_id = $2
		AND trashed_with IS NOT DISTINCT FROM $3 ORDER BY position, id`, wid, id, trashedWith)
	p.Children, err = collectRefs(rows, err)
	return p, err
}

// loadVisible reads a page the viewer may see (in the trash or not), else not found.
func loadVisible(ctx context.Context, q db.Querier, v Viewer, wid, id uuid.UUID) (WikiPage, error) {
	if err := mustSee(ctx, q, v, wid, id); err != nil {
		return WikiPage{}, err
	}
	return loadPage(ctx, q, wid, id)
}

// mustSee answers not found for a page the viewer may not see, as if it didn't exist.
func mustSee(ctx context.Context, q db.Querier, v Viewer, wid, id uuid.UUID) error {
	me, hidden := v.args()
	var area string
	err := q.QueryRow(ctx, `SELECT p.area FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2 AND `+seesSQL("p", 3, 4),
		wid, id, me, hidden).Scan(&area)
	if db.IsNotFound(err) {
		return httpx.NotFound("Page")
	}
	if err != nil {
		return err
	}
	return requireArea(ctx, q, wid, area)
}

// requireArea refuses Pages' pages while the workspace has Pages off (contracts/pages.md):
// they stay stored, out of reach until it is on again.
func requireArea(ctx context.Context, q db.Querier, wid uuid.UUID, area string) error {
	if area != AreaPages {
		return nil
	}
	return products.RequirePages(ctx, q, wid)
}

// areasOn are the areas the workspace has on, for lists across both (favorites, search):
// the wiki's always, Pages' unless the workspace has Pages off.
func areasOn(ctx context.Context, q db.Querier, wid uuid.UUID) ([]string, error) {
	err := products.RequirePages(ctx, q, wid)
	var disabled *products.DisabledError
	switch {
	case err == nil:
		return []string{AreaWiki, AreaPages}, nil
	case errors.As(err, &disabled):
		return []string{AreaWiki}, nil
	default:
		return nil, err
	}
}

// areaIn names the tree a list reads; the wiki's when left out.
type areaIn struct {
	Area string `query:"area" enum:"wiki,pages" default:"wiki" doc:"Whose pages: the wiki's or Pages' (contracts/pages.md)"`
}

// LoadPage reads a page the viewer may see in the tree, for workspace-side reads such as
// procedures (contracts/wiki.md "AI"). A page in the trash, a template or one out of the
// viewer's sight is not found.
func LoadPage(ctx context.Context, q db.Querier, v Viewer, wid, id uuid.UUID) (WikiPage, error) {
	me, hidden := v.args()
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2 AND `+liveSQL("p", 3, 4)+`)`,
		wid, id, me, hidden).Scan(&ok); err != nil {
		return WikiPage{}, err
	}
	if !ok {
		return WikiPage{}, pgx.ErrNoRows
	}
	pg, err := loadPage(ctx, q, wid, id)
	if err != nil {
		return pg, err
	}
	return pg, requireArea(ctx, q, wid, pg.Area)
}

// pageEvent publishes an event about a page to the people who may see it: a private page's
// member only, a private team's page that team only, else the workspace.
func pageEvent(ctx context.Context, tx pgx.Tx, wid uuid.UUID, pg WikiPage, typ string, data any) error {
	ev := events.Event{WorkspaceID: wid, Type: typ, Data: data}
	switch {
	case pg.owner != nil:
		ev.Users = []uuid.UUID{*pg.owner}
	case pg.TeamID != nil:
		var private bool
		if err := tx.QueryRow(ctx, `SELECT private FROM teams WHERE workspace_id = $1 AND id = $2`, wid, *pg.TeamID).Scan(&private); err != nil && !db.IsNotFound(err) {
			return err
		}
		if private {
			ev.TeamID = pg.TeamID
		}
	}
	_, err := events.Publish(ctx, tx, ev)
	return err
}

// ancestors are the pages above id, the top-level one first.
func ancestors(ctx context.Context, q db.Querier, wid, id uuid.UUID) ([]WikiRef, error) {
	rows, err := q.Query(ctx, `WITH RECURSIVE up(id, parent_id, title, icon, depth) AS (
			SELECT p.id, p.parent_id, p.title, p.icon, 0 FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2
			UNION ALL
			SELECT p.id, p.parent_id, p.title, p.icon, up.depth + 1 FROM wiki_pages p JOIN up ON p.id = up.parent_id
			WHERE p.workspace_id = $1 AND up.depth < 64
		)
		SELECT id, title, icon FROM up WHERE depth > 0 ORDER BY depth DESC`, wid, id)
	return collectRefs(rows, err)
}

func collectRefs(rows pgx.Rows, err error) ([]WikiRef, error) {
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (WikiRef, error) {
		var x WikiRef
		err := r.Scan(&x.ID, &x.Title, &x.Icon)
		return x, err
	})
	if out == nil {
		out = []WikiRef{}
	}
	return out, err
}

// subtree is id and every page under it that is in the same state (both in the tree, or
// trashed together), and how many levels it spans (1: no subpages).
func subtree(ctx context.Context, q db.Querier, wid, id uuid.UUID) ([]uuid.UUID, int, error) {
	rows, err := q.Query(ctx, `WITH RECURSIVE down(id, trashed_with, depth) AS (
			SELECT id, trashed_with, 1 FROM wiki_pages WHERE workspace_id = $1 AND id = $2
			UNION ALL
			SELECT p.id, p.trashed_with, down.depth + 1 FROM wiki_pages p JOIN down ON p.parent_id = down.id
			WHERE p.workspace_id = $1 AND down.depth < 64 AND p.trashed_with IS NOT DISTINCT FROM down.trashed_with
		)
		SELECT id, depth FROM down ORDER BY depth`, wid, id)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []uuid.UUID
	height := 0
	for rows.Next() {
		var x uuid.UUID
		var depth int
		if err := rows.Scan(&x, &depth); err != nil {
			return nil, 0, err
		}
		out = append(out, x)
		height = max(height, depth)
	}
	return out, height, rows.Err()
}

// lockTree serializes the workspace's changes to the tree (create, move, delete), so
// counts, depths and cycle checks see each other's results.
func lockTree(ctx context.Context, tx pgx.Tx, wid uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text || ':wiki'))`, wid)
	return err
}

// parent is a page that another goes under: where it lives and how deep it is.
type parent struct {
	id       uuid.UUID
	up       []WikiRef
	owner    *uuid.UUID
	team     *uuid.UUID
	template bool
	journal  bool
	area     string
	// database: the parent is a database, and a page under it is one of its rows.
	database *Database
}

// parentRef resolves a parent page id ("" is the top level): a page of the tree the viewer
// may see. A page in the trash or out of sight is refused like a page of another workspace.
func parentRef(ctx context.Context, q db.Querier, v Viewer, wid uuid.UUID, raw *string) (*parent, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	id, err := hd.ParseRef(*raw, "parent_id")
	if err != nil {
		return nil, err
	}
	me, hidden := v.args()
	par := parent{id: id}
	var database []byte
	err = q.QueryRow(ctx, `SELECT p.private_to, p.team_id, p.template, p.journal, p.database, p.area FROM wiki_pages p
		WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL AND `+seesSQL("p", 3, 4), wid, id, me, hidden).Scan(&par.owner, &par.team, &par.template, &par.journal, &database, &par.area)
	if db.IsNotFound(err) {
		return nil, httpx.Validation("parent page not found in this workspace")
	}
	if err != nil {
		return nil, err
	}
	if database != nil {
		par.database = new(Database)
		if err := json.Unmarshal(database, par.database); err != nil {
			return nil, err
		}
	}
	if err := requireArea(ctx, q, wid, par.area); err != nil {
		return nil, err
	}
	if par.up, err = ancestors(ctx, q, wid, id); err != nil {
		return nil, err
	}
	return &par, nil
}

// spaceRef resolves the space a top-level page goes to: "workspace", "private" or "team"
// (with team_id, a team of the workspace the viewer may see).
func spaceRef(ctx context.Context, q db.Querier, v Viewer, wid uuid.UUID, space string, rawTeam *string) (owner, team *uuid.UUID, err error) {
	switch space {
	case "", "workspace":
		return nil, nil, nil
	case "private":
		if v.Me == nil {
			return nil, nil, httpx.Validation("only a person has private pages")
		}
		return v.Me, nil, nil
	case "team":
		if rawTeam == nil {
			return nil, nil, httpx.Validation("team_id is required for a teamspace page")
		}
		id, err := hd.ParseRef(*rawTeam, "team_id")
		if err != nil {
			return nil, nil, err
		}
		var exists bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM teams WHERE workspace_id = $1 AND id = $2 AND NOT id = ANY($3::uuid[]))`, wid, id, v.Hidden).Scan(&exists); err != nil {
			return nil, nil, err
		}
		if !exists {
			return nil, nil, httpx.Validation("team not found in this workspace")
		}
		return nil, &id, nil
	}
	return nil, nil, httpx.Validation("space must be workspace, private or team")
}

// place puts id at index among the children of parent in the tree (the end when index is
// past it, or nil) and numbers them from 0. With id nil it only renumbers them. Top-level
// pages are numbered within their area and space (templates, shared by both areas, within
// their space); trashed pages and templates keep their numbers.
func place(ctx context.Context, tx pgx.Tx, wid uuid.UUID, area string, par *uuid.UUID, owner, team *uuid.UUID, template bool, id *uuid.UUID, index *int) error {
	rows, err := tx.Query(ctx, `SELECT id FROM wiki_pages WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2
		AND deleted_at IS NULL AND template = $5
		AND ($2::uuid IS NOT NULL OR (private_to IS NOT DISTINCT FROM $3 AND team_id IS NOT DISTINCT FROM $4 AND ($5 OR area = $7)))
		AND ($6::uuid IS NULL OR id <> $6) ORDER BY position, created_at, id FOR UPDATE`, wid, par, owner, team, template, id, area)
	if err != nil {
		return err
	}
	order, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	if id != nil {
		at := len(order)
		if index != nil && *index >= 0 && *index < at {
			at = *index
		}
		order = append(order[:at], append([]uuid.UUID{*id}, order[at:]...)...)
	}
	_, err = tx.Exec(ctx, `UPDATE wiki_pages p SET position = o.n - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, n)
		WHERE p.workspace_id = $1 AND p.id = o.id AND p.position <> o.n - 1`, wid, order)
	return err
}

// cleanTitle folds whitespace; a page may stay untitled.
func cleanTitle(s string) string {
	return hd.Truncate(strings.Join(strings.Fields(s), " "), maxTitle)
}

// cleanIcon accepts one emoji or nothing.
func cleanIcon(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if len(s) > 64 || !hd.IsEmoji(s) {
		return "", httpx.Validation("icon must be one emoji")
	}
	return s, nil
}

// coverGradients are the covers the app paints itself (web/src/components/wiki/covers.ts).
var coverGradients = map[string]bool{"dawn": true, "ocean": true, "forest": true, "dusk": true, "sand": true, "slate": true, "rose": true, "lagoon": true, "aurora": true, "ember": true}

// cleanCover accepts no cover, one of the app's gradients, or an image the wiki may show.
func cleanCover(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if name, ok := strings.CutPrefix(s, "gradient:"); ok && coverGradients[name] {
		return s, nil
	}
	if len(s) <= 2000 && hd.WikiSrc(s) {
		return s, nil
	}
	return "", httpx.Validation("cover must be a gradient, an https image or an uploaded image")
}

// cleanBody sanitizes a page body: the rich-text allowlist and the wiki's blocks (contracts/wiki.md "Body"),
// with links to our own files kept as their plain path ("Files").
func cleanBody(raw string) (string, error) {
	if len(raw) > maxBodyBytes {
		return "", httpx.E(422, "page_too_large", "A page can hold up to 512 KB of text and formatting. Split it into subpages.")
	}
	return hd.PlainFiles(hd.SanitizeWiki(raw)), nil
}

func inTrash() error {
	return httpx.E(http.StatusUnprocessableEntity, "page_in_trash", "This page is in the trash. Restore it to change it.")
}
