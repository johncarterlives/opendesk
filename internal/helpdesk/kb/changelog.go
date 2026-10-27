package kb

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// ChangelogEntry is ChangelogEntry from contracts/api.md.
type ChangelogEntry struct {
	ID          uuid.UUID       `json:"id"`
	Title       string          `json:"title"`
	Slug        string          `json:"slug"`
	Excerpt     string          `json:"excerpt"`
	BodyHTML    string          `json:"body_html"`
	Categories  []string        `json:"categories" doc:"Up to 5 names, such as New, Improved or Fixed"`
	Status      string          `json:"status" enum:"draft,published"`
	PublishedAt *time.Time      `json:"published_at" doc:"The date it carries; a published entry dated in the future shows from then"`
	Author      *domain.UserRef `json:"author"`
	BrandID     *uuid.UUID      `json:"brand_id" doc:"The brand whose help center shows it; null = every brand"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

// Category limits (contracts/api.md "Changelog").
const (
	maxCategories   = 5
	maxCategoryLen  = 32
	changelogPublic = 20 // the public list's default page
)

const entrySelect = `SELECT e.id, e.title, e.slug, e.excerpt, e.body_html, e.categories, e.status, e.published_at,
	u.id, u.name, u.email, u.avatar_url, e.brand_id, e.created_at, e.updated_at
FROM changelog_entries e LEFT JOIN users u ON u.id = e.author_id`

func scanEntry(row pgx.Row) (ChangelogEntry, error) {
	var e ChangelogEntry
	var uID *uuid.UUID
	var uName, uEmail, uAvatar *string
	err := row.Scan(&e.ID, &e.Title, &e.Slug, &e.Excerpt, &e.BodyHTML, &e.Categories, &e.Status, &e.PublishedAt,
		&uID, &uName, &uEmail, &uAvatar, &e.BrandID, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return e, err
	}
	if e.Categories == nil {
		e.Categories = []string{}
	}
	if uID != nil {
		e.Author = &domain.UserRef{ID: *uID, Name: deref(uName), Email: deref(uEmail), AvatarURL: domain.Avatar(deref(uAvatar))}
	}
	return e, nil
}

func loadEntry(ctx context.Context, q db.Querier, wid, id uuid.UUID) (ChangelogEntry, error) {
	return scanEntry(q.QueryRow(ctx, entrySelect+` WHERE e.workspace_id = $1 AND e.id = $2`, wid, id))
}

// publicEntry strips what an anonymous reader must not see: the author's email.
func publicEntry(e ChangelogEntry) ChangelogEntry {
	if e.Author != nil {
		u := *e.Author
		u.Email = ""
		e.Author = &u
	}
	return e
}

// cleanCategories collapses whitespace, drops empty names and second spellings of one
// already listed, and refuses more than maxCategories or a name over maxCategoryLen.
func cleanCategories(in []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, c := range in {
		c = strings.Join(strings.Fields(c), " ")
		if c == "" || seen[strings.ToLower(c)] {
			continue
		}
		if utf8.RuneCountInString(c) > maxCategoryLen {
			return nil, httpx.Validation("a category is at most 32 characters")
		}
		seen[strings.ToLower(c)] = true
		out = append(out, c)
	}
	if len(out) > maxCategories {
		return nil, httpx.Validation("an entry has at most 5 categories")
	}
	return out, nil
}

// changelogVisible is the predicate for the entries the help center of the brand bound as
// $n shows to the public: published, dated now or earlier, of that brand or every brand.
// The workspace is $1.
func changelogVisible(n int) string {
	p := "$" + itoaArg(n)
	return `e.workspace_id = $1 AND e.status = 'published' AND e.published_at <= now() AND COALESCE(e.brand_id, ` + p + `) = ` + p
}

// categoryMatch is the predicate for entries with the category bound as $n, compared
// without case.
func categoryMatch(n int) string {
	return `EXISTS (SELECT 1 FROM unnest(e.categories) c WHERE lower(c) = lower($` + itoaArg(n) + `))`
}

// Changelog returns a page of the help center's public entries, newest first, and whether
// more follow. category narrows it when set.
func Changelog(ctx context.Context, q db.Querier, hc HelpCenter, category string, offset, limit int) ([]ChangelogEntry, bool, error) {
	args := []any{hc.WorkspaceID, hc.BrandID, limit + 1, offset}
	where := changelogVisible(2)
	if category = strings.TrimSpace(category); category != "" {
		args = append(args, category)
		where += ` AND ` + categoryMatch(5)
	}
	rows, err := q.Query(ctx, entrySelect+` WHERE `+where+` ORDER BY e.published_at DESC, e.id DESC LIMIT $3 OFFSET $4`, args...)
	out, err := collectRows(rows, err, scanEntry)
	if err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	for i := range out {
		out[i] = publicEntry(out[i])
	}
	return out, more, nil
}

// ChangelogEntryBySlug returns a public entry of the help center, or a not-found error.
func ChangelogEntryBySlug(ctx context.Context, q db.Querier, hc HelpCenter, slug string) (ChangelogEntry, error) {
	e, err := scanEntry(q.QueryRow(ctx, entrySelect+` WHERE `+changelogVisible(2)+` AND e.slug = $3`, hc.WorkspaceID, hc.BrandID, slug))
	return publicEntry(e), err
}

// ChangelogCategories are the categories of the help center's public entries, most used
// first, each in its most common spelling.
func ChangelogCategories(ctx context.Context, q db.Querier, hc HelpCenter) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT mode() WITHIN GROUP (ORDER BY c) FROM changelog_entries e, unnest(e.categories) c
		WHERE `+changelogVisible(2)+` GROUP BY lower(c) ORDER BY count(*) DESC, 1 LIMIT 20`, hc.WorkspaceID, hc.BrandID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
