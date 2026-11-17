package hd

import (
	"context"
	"html"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
)

// Files a body names: wiki pages (contracts/wiki.md "Files"), knowledge base articles and
// changelog entries (contracts/api.md "Knowledge base") keep one of our files as its plain
// path, /v1/attachments/<id>, and hand out a link to it as they are read.

const fileIDPattern = `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`

var fileRef = regexp.MustCompile(`/v1/attachments/(` + fileIDPattern + `)`)

// fileAttr matches an attribute naming one of our files: its path, or a link to it at the
// API's address, signed or not. Group 1 is the attribute up to its value, 2 the path, 3 the id.
func fileAttr() *regexp.Regexp {
	host := ""
	if base := domain.APIURL(); base != "" {
		host = `(?:` + regexp.QuoteMeta(base) + `)?`
	}
	return regexp.MustCompile(`((?:src|data-src|href)=")` + host + `(/v1/attachments/(` + fileIDPattern + `))(?:\?[^"]*)?"`)
}

// FileIDs are the attachment ids a body names, each once.
func FileIDs(body string) []uuid.UUID {
	var out []uuid.UUID
	for _, m := range fileRef.FindAllStringSubmatch(body, -1) {
		if id, err := uuid.Parse(m[1]); err == nil && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// PlainFiles keeps every link to one of our files as its plain path.
func PlainFiles(body string) string {
	if !strings.Contains(body, "/v1/attachments/") {
		return body
	}
	return fileAttr().ReplaceAllString(body, `$1$2"`)
}

// LinkFiles points every link to one of our files at link(id), escaped for the attribute;
// a file for which link returns "" keeps its plain path.
func LinkFiles(body string, link func(id uuid.UUID) string) string {
	if !strings.Contains(body, "/v1/attachments/") {
		return body
	}
	re := fileAttr()
	return re.ReplaceAllStringFunc(body, func(m string) string {
		g := re.FindStringSubmatch(m)
		to := ""
		if id, err := uuid.Parse(g[3]); err == nil {
			to = link(id)
		}
		if to == "" {
			return g[1] + g[2] + `"`
		}
		return g[1] + html.EscapeString(to) + `"`
	})
}

// FileHolder is the attachments column naming the knowledge base article or changelog entry
// that holds a file.
type FileHolder string

const (
	ArticleFiles FileHolder = "kb_article_id"
	EntryFiles   FileHolder = "changelog_entry_id"
)

// ReleaseFiles lets go of the files the owners (articles or entries, per col; ids of either
// may be mixed in) of workspace wid hold, other than keep, and hands each to an article of the
// workspace that is not one of the owners and whose body names it (a published one first, then the oldest), else to such a
// changelog entry (a shown one first), so a help center that shows it keeps serving it. A
// file nothing else holds or names is left for the sweep of unattached uploads. Run it in the
// transaction that saves the owners' bodies, or that deletes the owners, before the delete
// (contracts/api.md "Article and changelog files").
func ReleaseFiles(ctx context.Context, tx pgx.Tx, wid uuid.UUID, col FileHolder, owners, keep []uuid.UUID) error {
	if len(owners) == 0 {
		return nil
	}
	if keep == nil {
		keep = []uuid.UUID{}
	}
	rows, err := tx.Query(ctx, `UPDATE attachments SET `+string(col)+` = NULL
		WHERE workspace_id = $1 AND `+string(col)+` = ANY($2) AND NOT (id = ANY($3)) RETURNING id`, wid, owners, keep)
	if err != nil {
		return err
	}
	files, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil || len(files) == 0 {
		return err
	}
	const unheld = `a.workspace_id = $1 AND a.id = ANY($2) AND a.message_id IS NULL AND a.wiki_page_id IS NULL
		AND a.kb_article_id IS NULL AND a.changelog_entry_id IS NULL`
	if _, err := tx.Exec(ctx, `UPDATE attachments a SET kb_article_id = x.owner
		FROM (SELECT DISTINCT ON (f.id) f.id, k.id AS owner FROM attachments f
			JOIN kb_articles k ON k.workspace_id = f.workspace_id AND NOT (k.id = ANY($3))
				AND strpos(lower(k.body_html), '/v1/attachments/' || f.id::text) > 0
			WHERE f.workspace_id = $1 AND f.id = ANY($2)
			ORDER BY f.id, (k.status = 'published') DESC, k.created_at, k.id) x
		WHERE a.id = x.id AND `+unheld, wid, files, owners); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE attachments a SET changelog_entry_id = x.owner
		FROM (SELECT DISTINCT ON (f.id) f.id, e.id AS owner FROM attachments f
			JOIN changelog_entries e ON e.workspace_id = f.workspace_id AND NOT (e.id = ANY($3))
				AND strpos(lower(e.body_html), '/v1/attachments/' || f.id::text) > 0
			WHERE f.workspace_id = $1 AND f.id = ANY($2)
			ORDER BY f.id, (e.status = 'published' AND e.published_at <= now()) DESC, e.created_at, e.id) x
		WHERE a.id = x.id AND `+unheld, wid, files, owners)
	return err
}
