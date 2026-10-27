package kb

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/brands"
)

// HelpCenter is a brand's public help center: what its pages read (the JSON routes here
// and the rendered site, internal/helpdesk/helpsite).
type HelpCenter struct {
	BrandID     uuid.UUID
	WorkspaceID uuid.UUID
	Slug        string
	Title       string // the brand's help center title, else its name
	Locale      string // the brand's, else the workspace's; "" when neither is set
	LocaleFixed bool   // pages always use Locale, whatever the reader's browser
	Color       string // the brand's colour, else the workspace brand_color; "" when neither is set
	Logo        domain.Avatar
	Favicon     domain.Avatar
	Enabled     bool
	ActiveHost  string // the active custom domain, or ""
	Changelog   bool   // it has a public changelog entry
}

// A suspended workspace's help centers read as off (contracts/admin.md).
var helpCenterSelect = `SELECT b.id, b.workspace_id, b.slug, b.name, b.help_center_title, b.help_center_enabled AND w.suspended_at IS NULL, b.locale, b.color, b.images,
	COALESCE(w.settings ->> 'locale', ''), COALESCE(w.settings ->> 'locale_fixed' = 'true', false), COALESCE(w.settings ->> 'brand_color', ''), w.avatar_url, COALESCE(` + brands.ActiveHostSQL("b.id") + `, ''),
	EXISTS (SELECT 1 FROM changelog_entries e WHERE e.workspace_id = b.workspace_id AND e.status = 'published' AND e.published_at <= now() AND COALESCE(e.brand_id, b.id) = b.id)
	FROM brands b JOIN workspaces w ON w.id = b.workspace_id`

func loadHelpCenter(ctx context.Context, q db.Querier, where string, arg any) (HelpCenter, error) {
	var hc HelpCenter
	var name, title, wsLocale, wsColor string
	var imgs map[string]string
	var wsLogo domain.Avatar
	err := q.QueryRow(ctx, helpCenterSelect+` WHERE `+where, arg).
		Scan(&hc.BrandID, &hc.WorkspaceID, &hc.Slug, &name, &title, &hc.Enabled, &hc.Locale, &hc.Color, &imgs, &wsLocale, &hc.LocaleFixed, &wsColor, &wsLogo, &hc.ActiveHost, &hc.Changelog)
	if err != nil {
		return hc, err
	}
	hc.Title = strings.TrimSpace(title)
	if hc.Title == "" {
		hc.Title = name
	}
	if hc.Locale == "" {
		hc.Locale = wsLocale
	}
	hc.LocaleFixed = hc.LocaleFixed && hc.Locale != ""
	if hc.Color == "" {
		hc.Color = wsColor
	}
	hc.Logo, hc.Favicon = domain.Avatar(imgs["help_center_logo"]), domain.Avatar(imgs["help_center_favicon"])
	if hc.Logo == "" {
		hc.Logo = domain.Avatar(imgs["logo"])
	}
	if hc.Logo == "" {
		hc.Logo = wsLogo
	}
	return hc, nil
}

// HelpCenterBySlug returns the help center of a brand slug, enabled or not.
func HelpCenterBySlug(ctx context.Context, q db.Querier, slug string) (HelpCenter, error) {
	return loadHelpCenter(ctx, q, `b.slug = $1`, strings.ToLower(strings.TrimSpace(slug)))
}

// HelpCenterByHost returns the help center whose active custom domain is host.
func HelpCenterByHost(ctx context.Context, q db.Querier, host string) (HelpCenter, error) {
	return loadHelpCenter(ctx, q, `b.id = (SELECT hd.brand_id FROM help_domains hd WHERE hd.hostname = $1 AND hd.status = 'active')`, host)
}

// Collections are the help center's topics that have a published article, in order.
func Collections(ctx context.Context, q db.Querier, hc HelpCenter) ([]KbCollection, error) {
	rows, err := q.Query(ctx, publicCollectionSelect+` WHERE k.workspace_id = $2 AND COALESCE(k.brand_id, $1) = $1
		AND EXISTS (SELECT 1 FROM kb_articles a WHERE a.collection_id = k.id AND a.status = 'published' AND COALESCE(k.brand_id, a.brand_id, $1) = $1)
		ORDER BY k.position, k.name, k.id`, hc.BrandID, hc.WorkspaceID)
	return collectRows(rows, err, scanCollection)
}

// Featured are the help center's most read articles.
func Featured(ctx context.Context, q db.Querier, hc HelpCenter, limit int) ([]KbArticle, error) {
	rows, err := q.Query(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.status = 'published' AND `+forBrand(3)+`
		ORDER BY a.views DESC, a.published_at DESC NULLS LAST, a.id LIMIT $2`, hc.WorkspaceID, limit, hc.BrandID)
	arts, err := collectRows(rows, err, scanArticle)
	return publicList(arts), err
}

// CollectionBySlug returns a topic of the help center and its published articles, or a
// not-found error.
func CollectionBySlug(ctx context.Context, q db.Querier, hc HelpCenter, slug string) (KbCollection, []KbArticle, error) {
	c, err := scanCollection(q.QueryRow(ctx, publicCollectionSelect+` WHERE k.workspace_id = $2 AND k.slug = $3
		AND COALESCE(k.brand_id, $1) = $1`, hc.BrandID, hc.WorkspaceID, slug))
	if err != nil {
		return c, nil, err
	}
	rows, err := q.Query(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.collection_id = $2 AND a.status = 'published'
		AND `+forBrand(3)+` ORDER BY a.position, a.title, a.id`, hc.WorkspaceID, c.ID, hc.BrandID)
	arts, err := collectRows(rows, err, scanArticle)
	return c, publicList(arts), err
}

// ArticleBySlug returns a published article of the help center, or a not-found error.
func ArticleBySlug(ctx context.Context, q db.Querier, hc HelpCenter, slug string) (KbArticle, error) {
	a, err := scanArticle(q.QueryRow(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.slug = $2 AND a.status = 'published' AND `+forBrand(3),
		hc.WorkspaceID, slug, hc.BrandID))
	return public(a), err
}

// CountView counts a view of a published article of the help center; false when it is
// not one.
func CountView(ctx context.Context, q db.Querier, hc HelpCenter, id uuid.UUID) (bool, error) {
	tag, err := q.Exec(ctx, `UPDATE kb_articles a SET views = views + 1
		WHERE a.workspace_id = $1 AND a.id = $2 AND a.status = 'published' AND `+forBrand(3), hc.WorkspaceID, id, hc.BrandID)
	return tag.RowsAffected() == 1, err
}

// SearchHelpCenter returns the help center's published articles matching q, best first.
func SearchHelpCenter(ctx context.Context, q db.Querier, hc HelpCenter, query string) ([]KbArticle, error) {
	query = strings.TrimSpace(query)
	pq := prefixQuery(query)
	if pq == "" {
		return []KbArticle{}, nil
	}
	tsq := searchQuery(2)
	rows, err := q.Query(ctx, articleSelect+` WHERE a.workspace_id = $1 AND a.status = 'published' AND a.search @@ `+tsq+`
		AND `+forBrand(5)+` ORDER BY ts_rank(a.search, `+tsq+`) DESC, a.views DESC, a.id LIMIT $4`, hc.WorkspaceID, query, pq, publicSearchLimit, hc.BrandID)
	arts, err := collectRows(rows, err, scanArticle)
	return publicList(arts), err
}

// SitemapEntry is one page of a help center's sitemap.
type SitemapEntry struct {
	Kind      string // "collection" | "article" | "changelog"
	Slug      string
	UpdatedAt time.Time
}

// maxSitemap is what one sitemap file may list.
const maxSitemap = 50000

// Sitemap lists the help center's topics, published articles and public changelog entries,
// each with when it last changed (a topic: its newest article).
func Sitemap(ctx context.Context, q db.Querier, hc HelpCenter) ([]SitemapEntry, error) {
	rows, err := q.Query(ctx, `SELECT 'collection', k.slug, max(a.updated_at) FROM kb_collections k
			JOIN kb_articles a ON a.collection_id = k.id AND a.status = 'published' AND COALESCE(k.brand_id, a.brand_id, $1) = $1
			WHERE k.workspace_id = $2 AND COALESCE(k.brand_id, $1) = $1 GROUP BY k.id, k.slug
		UNION ALL
		(SELECT 'article', a.slug, a.updated_at FROM kb_articles a
			WHERE a.workspace_id = $2 AND a.status = 'published' AND `+forBrand(1)+` ORDER BY a.updated_at DESC LIMIT $3)
		UNION ALL
		(SELECT 'changelog', e.slug, e.updated_at FROM changelog_entries e
			WHERE e.workspace_id = $2 AND e.status = 'published' AND e.published_at <= now() AND COALESCE(e.brand_id, $1) = $1
			ORDER BY e.published_at DESC LIMIT 1000)`,
		hc.BrandID, hc.WorkspaceID, maxSitemap-2000)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SitemapEntry
	for rows.Next() {
		var e SitemapEntry
		if err := rows.Scan(&e.Kind, &e.Slug, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
