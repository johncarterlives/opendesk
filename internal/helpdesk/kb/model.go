package kb

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
)

// Collection is KbCollection from contracts/api.md.
type KbCollection struct {
	ID           uuid.UUID  `json:"id"`
	Name         string     `json:"name"`
	Slug         string     `json:"slug"`
	Description  string     `json:"description"`
	Position     int        `json:"position"`
	ArticleCount int        `json:"article_count"`
	BrandID      *uuid.UUID `json:"brand_id" doc:"The brand whose help center shows it; null = every brand"`
}

// Article is KbArticle from contracts/api.md.
type KbArticle struct {
	ID           uuid.UUID       `json:"id"`
	CollectionID *uuid.UUID      `json:"collection_id"`
	Title        string          `json:"title"`
	Slug         string          `json:"slug"`
	Excerpt      string          `json:"excerpt"`
	BodyHTML     string          `json:"body_html"`
	Status       string          `json:"status" enum:"draft,published"`
	Author       *domain.UserRef `json:"author"`
	Views        int64           `json:"views"`
	PublishedAt  *time.Time      `json:"published_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
	BrandID      *uuid.UUID      `json:"brand_id" doc:"The brand whose help center shows it; null = every brand. An article in a collection with a brand follows the collection's"`
	// Path is where the article lives on a help center, after its address:
	// /c/<collection slug>/<slug>, or /a/<slug> outside any collection.
	Path string `json:"path" doc:"The article's address on a help center, after the help center's own: /c/<collection slug>/<slug>, or /a/<slug> in no collection"`
}

// collectionSelect counts every article, or only published ones when $published is true.
// The caller supplies the count flag as the first parameter.
const collectionSelect = `SELECT k.id, k.name, k.slug, k.description, k.position,
	(SELECT count(*) FROM kb_articles a WHERE a.collection_id = k.id AND (NOT $1 OR a.status = 'published')), k.brand_id
FROM kb_collections k`

// publicCollectionSelect counts the published articles the help center of brand $1 shows.
const publicCollectionSelect = `SELECT k.id, k.name, k.slug, k.description, k.position,
	(SELECT count(*) FROM kb_articles a WHERE a.collection_id = k.id AND a.status = 'published' AND COALESCE(k.brand_id, a.brand_id, $1) = $1),
	k.brand_id
FROM kb_collections k`

// articleBrand is the brand an article belongs to: its collection's when that has one,
// else its own; NULL is every brand.
const articleBrand = `COALESCE((SELECT kc.brand_id FROM kb_collections kc WHERE kc.id = a.collection_id), a.brand_id)`

// forBrand is the predicate for articles the help center of the brand bound as $n shows.
func forBrand(n int) string {
	p := "$" + strconv.Itoa(n)
	return `COALESCE(` + articleBrand + `, ` + p + `) = ` + p
}

func scanCollection(row pgx.Row) (KbCollection, error) {
	var c KbCollection
	err := row.Scan(&c.ID, &c.Name, &c.Slug, &c.Description, &c.Position, &c.ArticleCount, &c.BrandID)
	return c, err
}

func collectRows[T any](rows pgx.Rows, err error, scan func(pgx.Row) (T, error)) ([]T, error) {
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) { return scan(r) })
	if out == nil {
		out = []T{}
	}
	return out, err
}

func loadCollection(ctx context.Context, q db.Querier, wid, id uuid.UUID) (KbCollection, error) {
	return scanCollection(q.QueryRow(ctx, collectionSelect+` WHERE k.workspace_id = $2 AND k.id = $3`, false, wid, id))
}

const articleSelect = `SELECT a.id, a.collection_id, a.title, a.slug, a.excerpt, a.body_html, a.status, a.views,
	a.published_at, a.updated_at, u.id, u.name, u.email, u.avatar_url, a.brand_id, ` + articlePath + `
FROM kb_articles a LEFT JOIN users u ON u.id = a.author_id`

// articlePath is the help-center path of the article a (KbArticle.Path).
const articlePath = `COALESCE('/c/' || (SELECT pc.slug FROM kb_collections pc WHERE pc.id = a.collection_id) || '/', '/a/') || a.slug`

func scanArticle(row pgx.Row) (KbArticle, error) {
	var a KbArticle
	var uID *uuid.UUID
	var uName, uEmail, uAvatar *string
	err := row.Scan(&a.ID, &a.CollectionID, &a.Title, &a.Slug, &a.Excerpt, &a.BodyHTML, &a.Status, &a.Views,
		&a.PublishedAt, &a.UpdatedAt, &uID, &uName, &uEmail, &uAvatar, &a.BrandID, &a.Path)
	if err != nil {
		return a, err
	}
	if uID != nil {
		a.Author = &domain.UserRef{ID: *uID, Name: deref(uName), Email: deref(uEmail), AvatarURL: domain.Avatar(deref(uAvatar))}
	}
	return a, nil
}

func loadArticle(ctx context.Context, q db.Querier, wid, id uuid.UUID) (KbArticle, error) {
	return scanArticle(q.QueryRow(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.id = $2`, wid, id))
}

// public strips what an anonymous reader must not see: the author's email.
func public(a KbArticle) KbArticle {
	if a.Author != nil {
		u := *a.Author
		u.Email = ""
		a.Author = &u
	}
	return a
}

func publicList(in []KbArticle) []KbArticle {
	for i := range in {
		in[i] = public(in[i])
	}
	return in
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

var wordRe = regexp.MustCompile(`[\p{L}\p{N}]+`)

// prefixQuery builds a to_tsquery string matching every word as a prefix ("hel:* & wor:*"),
// so partially typed words match. Only letters and digits survive, so the string is
// always valid tsquery syntax.
func prefixQuery(q string) string {
	words := wordRe.FindAllString(strings.ToLower(q), 8)
	for i, w := range words {
		words[i] = w + ":*"
	}
	return strings.Join(words, " & ")
}

// searchQuery is the FTS predicate and rank over a.search for parameters $n (raw q) and
// $n+1 (prefix query from prefixQuery).
func searchQuery(n int) string {
	p1, p2 := "$"+strconv.Itoa(n), "$"+strconv.Itoa(n+1)
	return `(websearch_to_tsquery('simple', ` + p1 + `) || to_tsquery('simple', ` + p2 + `))`
}

func itoaArg(n int) string { return strconv.Itoa(n) }
