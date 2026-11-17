package kb

import (
	"context"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
)

// Search returns the workspace's best matching articles (drafts included) for the
// global search box. With brand, only that brand's articles and those every brand shows.
func Search(ctx context.Context, q db.Querier, wid uuid.UUID, query string, limit int, brand *uuid.UUID) ([]KbArticle, error) {
	pq := prefixQuery(query)
	if pq == "" {
		return []KbArticle{}, nil
	}
	tsq := searchQuery(2)
	rows, err := q.Query(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.search @@ `+tsq+`
		AND ($5::uuid IS NULL OR `+ForBrandSQL("$5")+`)
		ORDER BY ts_rank(a.search, `+tsq+`) DESC, a.updated_at DESC LIMIT $4`, wid, query, pq, limit, brand)
	arts, err := collectRows(rows, err, scanArticle)
	if err != nil {
		return nil, err
	}
	return arts, signArticles(ctx, q, wid, arts)
}

// ForBrandSQL is the predicate on articles aliased a for what the brand bound as param
// shows: its own articles and those with no brand.
func ForBrandSQL(param string) string {
	return `COALESCE(` + articleBrand + `, ` + param + `) = ` + param
}
