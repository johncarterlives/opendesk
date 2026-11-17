package wiki

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/products"
)

// Files (contracts/wiki.md "Files"): an upload a page's body names (`/v1/attachments/<id>`,
// signed or not) becomes the page's own as the page is saved, when the person or key saving
// it uploaded it and no message, page, article or changelog entry holds it yet. A page's
// files are kept while the page is and read by whoever may see the page; a page deleted for
// good lets go of them. Bodies keep a file as its plain path (hd.PlainFiles); a page read
// hands out signed links to the files of its space.

// signFiles gives the reader of page signed links to the files of the page's space (its own,
// and those of the pages beside it, which the same people see) and to those a knowledge base
// article or changelog entry of the workspace holds (which any member reads), so images load
// without a token. Any other file keeps its plain path.
func signFiles(ctx context.Context, q db.Querier, wid, page uuid.UUID, body string) (string, error) {
	files := hd.FileIDs(body)
	if len(files) == 0 {
		return body, nil
	}
	rows, err := q.Query(ctx, `SELECT a.id FROM attachments a
		JOIN wiki_pages h ON h.workspace_id = a.workspace_id AND h.id = a.wiki_page_id
		JOIN wiki_pages p ON p.workspace_id = $1 AND p.id = $2
		WHERE a.workspace_id = $1 AND a.id = ANY($3) AND a.message_id IS NULL
		AND h.private_to IS NOT DISTINCT FROM p.private_to AND h.team_id IS NOT DISTINCT FROM p.team_id
		UNION
		SELECT a.id FROM attachments a WHERE a.workspace_id = $1 AND a.id = ANY($3) AND a.message_id IS NULL AND a.wiki_page_id IS NULL
		AND (a.kb_article_id IS NOT NULL OR a.changelog_entry_id IS NOT NULL)`, wid, page, files)
	signed, err := collectIDs(rows, err)
	if err != nil || len(signed) == 0 {
		return hd.PlainFiles(body), err
	}
	ok := make(map[uuid.UUID]bool, len(signed))
	for _, id := range signed {
		ok[id] = true
	}
	return hd.LinkFiles(body, func(id uuid.UUID) string {
		if !ok[id] {
			return ""
		}
		return domain.AttachmentURL(id)
	}), nil
}

// claimFiles makes the uploads of the caller that body names the page's own.
func claimFiles(ctx context.Context, tx pgx.Tx, p *auth.Principal, page uuid.UUID, body string) error {
	files := hd.FileIDs(body)
	user, key := p.ActorUserID(), p.ActorAPIKeyID()
	if len(files) == 0 || (user == nil && key == nil) {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE attachments SET wiki_page_id = $3
		WHERE workspace_id = $1 AND id = ANY($2) AND message_id IS NULL AND wiki_page_id IS NULL
		AND kb_article_id IS NULL AND changelog_entry_id IS NULL
		AND (uploaded_by = $4 OR uploaded_by_api_key_id = $5)`, p.WorkspaceID, files, page, user, key)
	return err
}

// SeesPage reports whether the principal may see a page of their workspace, in the trash
// or not, a template or not: who reads the page's files. A page of Pages is out of sight
// while the workspace has Pages off.
func SeesPage(ctx context.Context, q db.Querier, p *auth.Principal, page uuid.UUID) (bool, error) {
	v, err := ViewerOf(ctx, q, p)
	if err != nil {
		return false, err
	}
	me, hidden := v.args()
	var area string
	err = q.QueryRow(ctx, `SELECT p.area FROM wiki_pages p WHERE p.workspace_id = $1 AND p.id = $2 AND `+seesSQL("p", 3, 4),
		p.WorkspaceID, page, me, hidden).Scan(&area)
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if area != AreaPages {
		return true, nil
	}
	err = products.RequirePages(ctx, q, p.WorkspaceID)
	var disabled *products.DisabledError
	if errors.As(err, &disabled) {
		return false, nil
	}
	return err == nil, err
}
