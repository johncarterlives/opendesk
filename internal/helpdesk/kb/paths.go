package kb

import (
	"context"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Article addresses (contracts/api.md "Knowledge base"): an article lives at
// /c/<collection slug>/<slug>, or /a/<slug> in no collection, so its slug is unique only among
// the articles of its collection. An address that moved (an article's slug or collection
// changed, a collection's slug changed, a collection was deleted) is kept in kb_redirects and
// answers 301 to where the article or collection is now.

// noCollection stands for "no collection" in the slug index.
var noCollection = uuid.UUID{}

// articleSlugTaken reports whether another article of the collection (nil: of no collection)
// already uses slug.
func articleSlugTaken(ctx context.Context, q db.Querier, wid uuid.UUID, collection *uuid.UUID, slug string, exclude *uuid.UUID) (bool, error) {
	var taken bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM kb_articles WHERE workspace_id = $1
		AND COALESCE(collection_id, $2) = COALESCE($3::uuid, $2) AND slug = $4 AND ($5::uuid IS NULL OR id <> $5))`,
		wid, noCollection, collection, slug, exclude).Scan(&taken)
	return taken, err
}

// pickArticleSlug is the slug an article takes in its collection: the one asked for, refused
// when another article of that collection has it, or one made from fallback with a number
// added until it is free.
func pickArticleSlug(ctx context.Context, q db.Querier, wid uuid.UUID, collection *uuid.UUID, requested *string, fallback string, exclude *uuid.UUID) (string, error) {
	if requested != nil && *requested != "" {
		slug := hd.Slugify(*requested)
		if slug == "" {
			return "", httpx.Validation("slug must contain letters or digits")
		}
		taken, err := articleSlugTaken(ctx, q, wid, collection, slug, exclude)
		if err != nil {
			return "", err
		}
		if taken {
			return "", httpx.Conflict("another article in this collection already uses that slug")
		}
		return slug, nil
	}
	return freeArticleSlug(ctx, q, wid, collection, hd.Slugify(fallback), exclude)
}

// freeArticleSlug is base, or base-2, base-3 and so on, whichever no other article of the
// collection uses.
func freeArticleSlug(ctx context.Context, q db.Querier, wid uuid.UUID, collection *uuid.UUID, base string, exclude *uuid.UUID) (string, error) {
	if base == "" {
		base = "article"
	}
	for i := 1; ; i++ {
		slug := base
		if i > 1 {
			slug = base + "-" + strconv.Itoa(i)
		}
		taken, err := articleSlugTaken(ctx, q, wid, collection, slug, exclude)
		if err != nil || !taken {
			return slug, err
		}
	}
}

// articlePathOf is the path an article with slug has in the collection with collectionSlug
// ("" for none).
func articlePathOf(collectionSlug, slug string) string {
	if collectionSlug == "" {
		return "/a/" + slug
	}
	return "/c/" + collectionSlug + "/" + slug
}

// redirectArticle records that path now leads to the article, in the write's transaction.
func redirectArticle(ctx context.Context, tx pgx.Tx, wid uuid.UUID, path string, article uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO kb_redirects (workspace_id, path, article_id) VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, path) DO UPDATE SET article_id = EXCLUDED.article_id, collection_id = NULL, created_at = now()`, wid, path, article)
	return err
}

// redirectCollection records that path (/c/<old slug>) now leads to the collection.
func redirectCollection(ctx context.Context, tx pgx.Tx, wid uuid.UUID, path string, collection uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO kb_redirects (workspace_id, path, collection_id) VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, path) DO UPDATE SET collection_id = EXCLUDED.collection_id, article_id = NULL, created_at = now()`, wid, path, collection)
	return err
}

// currentPath is the article's path as stored now, for recording it before a change.
func currentPath(ctx context.Context, q db.Querier, wid, id uuid.UUID) (string, error) {
	var path string
	err := q.QueryRow(ctx, `SELECT `+articlePath+` FROM kb_articles a WHERE a.workspace_id = $1 AND a.id = $2`, wid, id).Scan(&path)
	return path, err
}

// ArticleIn returns a published article of the help center by its collection's slug ("" for
// none) and its own, or a not-found error.
func ArticleIn(ctx context.Context, q db.Querier, hc HelpCenter, collectionSlug, slug string) (KbArticle, error) {
	where := `a.collection_id IS NULL`
	args := []any{hc.WorkspaceID, slug, hc.BrandID}
	if collectionSlug != "" {
		where = `a.collection_id = (SELECT k.id FROM kb_collections k WHERE k.workspace_id = $1 AND k.slug = $4)`
		args = append(args, collectionSlug)
	}
	a, err := scanArticle(q.QueryRow(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.slug = $2 AND `+where+`
		AND a.status = 'published' AND `+forBrand(3), args...))
	return public(a), err
}

// Moved is where an address that is no longer an article's or a collection's leads now: the
// path of the article or collection, if the help center shows it.
func Moved(ctx context.Context, q db.Querier, hc HelpCenter, path string) (string, bool, error) {
	var article, collection *uuid.UUID
	err := q.QueryRow(ctx, `SELECT article_id, collection_id FROM kb_redirects WHERE workspace_id = $1 AND path = $2`, hc.WorkspaceID, path).
		Scan(&article, &collection)
	if db.IsNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if article != nil {
		var to string
		err := q.QueryRow(ctx, `SELECT `+articlePath+` FROM kb_articles a WHERE a.workspace_id = $1 AND a.id = $2
			AND a.status = 'published' AND `+forBrand(3), hc.WorkspaceID, *article, hc.BrandID).Scan(&to)
		if db.IsNotFound(err) {
			return "", false, nil
		}
		return to, err == nil, err
	}
	var slug string
	err = q.QueryRow(ctx, `SELECT k.slug FROM kb_collections k WHERE k.workspace_id = $1 AND k.id = $2 AND COALESCE(k.brand_id, $3) = $3`,
		hc.WorkspaceID, *collection, hc.BrandID).Scan(&slug)
	if db.IsNotFound(err) {
		return "", false, nil
	}
	return "/c/" + slug, err == nil, err
}

// MovedCollectionID is the collection an old /c/<slug> leads to, if any.
func MovedCollectionID(ctx context.Context, q db.Querier, hc HelpCenter, slug string) (*uuid.UUID, error) {
	var id *uuid.UUID
	err := q.QueryRow(ctx, `SELECT collection_id FROM kb_redirects WHERE workspace_id = $1 AND path = $2 AND collection_id IS NOT NULL`,
		hc.WorkspaceID, "/c/"+slug).Scan(&id)
	if db.IsNotFound(err) {
		return nil, nil
	}
	return id, err
}

// ArticleInCollection is the path of the published article with slug in the collection id,
// if the help center shows it.
func ArticleInCollection(ctx context.Context, q db.Querier, hc HelpCenter, collection uuid.UUID, slug string) (string, bool, error) {
	var to string
	err := q.QueryRow(ctx, `SELECT `+articlePath+` FROM kb_articles a WHERE a.workspace_id = $1 AND a.collection_id = $2 AND a.slug = $3
		AND a.status = 'published' AND `+forBrand(4), hc.WorkspaceID, collection, slug, hc.BrandID).Scan(&to)
	if db.IsNotFound(err) {
		return "", false, nil
	}
	return to, err == nil, err
}
