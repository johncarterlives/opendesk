package kb_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/ids"
)

type article struct {
	ID           string  `json:"id"`
	CollectionID *string `json:"collection_id"`
	Title        string  `json:"title"`
	Slug         string  `json:"slug"`
	Excerpt      string  `json:"excerpt"`
	BodyHTML     string  `json:"body_html"`
	Status       string  `json:"status"`
	Views        int     `json:"views"`
	PublishedAt  *string `json:"published_at"`
	BrandID      *string `json:"brand_id"`
	Author       *struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"author"`
}

type collection struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Slug         string  `json:"slug"`
	ArticleCount int     `json:"article_count"`
	BrandID      *string `json:"brand_id"`
}

func createArticle(t *testing.T, e *hdtest.Env, a hdtest.Auth, body map[string]any) article {
	t.Helper()
	var out article
	e.Do("POST", "/v1/kb/articles", a, body).Want(t, 201).JSON(t, &out)
	return out
}

func TestCollectionsCRUD(t *testing.T) {
	e := hdtest.New(t, kb.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	_, seq := e.Events(ws.ID, 0)

	var c1, c2 collection
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "Getting Started!", "description": "Basics"}).Want(t, 201).JSON(t, &c1)
	if c1.Slug != "getting-started" {
		t.Fatalf("slug %q", c1.Slug)
	}
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "Getting started"}).Want(t, 201).JSON(t, &c2)
	if c2.Slug != "getting-started-2" {
		t.Fatalf("second slug %q", c2.Slug)
	}
	e.Do("PATCH", "/v1/kb/collections/"+c2.ID, agent, map[string]any{"slug": "getting-started"}).Want(t, 409)
	e.Do("PATCH", "/v1/kb/collections/"+c2.ID, agent, map[string]any{"slug": "Billing FAQ", "name": "Billing"}).Want(t, 200).JSON(t, &c2)
	if c2.Slug != "billing-faq" || c2.Name != "Billing" {
		t.Fatalf("patched %+v", c2)
	}
	art := createArticle(t, e, agent, map[string]any{"title": "Invoices", "body_html": "<p>x</p>", "collection_id": c2.ID})
	var list struct{ Data []collection }
	e.Do("GET", "/v1/kb/collections", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 2 || list.Data[1].ArticleCount+list.Data[0].ArticleCount != 1 {
		t.Fatalf("list %+v", list.Data)
	}
	e.Do("POST", "/v1/kb/collections", ws.Viewer.As(ws), map[string]any{"name": "Nope"}).Want(t, 403)
	e.Do("DELETE", "/v1/kb/collections/"+c2.ID, agent, nil).Want(t, 204)
	var got article
	e.Do("GET", "/v1/kb/articles/"+art.ID, agent, nil).Want(t, 200).JSON(t, &got)
	if got.CollectionID != nil {
		t.Fatal("article kept its deleted collection")
	}
	types, _ := e.Events(ws.ID, seq)
	for _, want := range []string{"kb_collection.created", "kb_collection.updated", "kb_collection.deleted", "kb_article.created"} {
		if !slices.Contains(types, want) {
			t.Errorf("missing event %s in %v", want, types)
		}
	}

	// Another workspace cannot see or change it.
	other := e.NewWorkspace()
	e.Do("GET", "/v1/kb/collections/"+c1.ID, other.Admin.As(other), nil).Want(t, 404)
	e.Do("PATCH", "/v1/kb/collections/"+c1.ID, other.Admin.As(other), map[string]any{"name": "x"}).Want(t, 404)
	e.Do("DELETE", "/v1/kb/collections/"+c1.ID, other.Admin.As(other), nil).Want(t, 404)
	// Nor reference it from an article.
	e.Do("POST", "/v1/kb/articles", other.Admin.As(other), map[string]any{"title": "x", "collection_id": c1.ID}).Want(t, 422)
}

func TestArticles(t *testing.T) {
	e := hdtest.New(t, kb.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)

	a := createArticle(t, e, agent, map[string]any{"title": "Reset your password",
		"body_html": `<p onclick="x()">Open <strong>settings</strong> and click reset.</p><script>alert(1)</script>`})
	if strings.Contains(a.BodyHTML, "script") || strings.Contains(a.BodyHTML, "onclick") || !strings.Contains(a.BodyHTML, "<strong>settings</strong>") {
		t.Fatalf("body not sanitized: %s", a.BodyHTML)
	}
	if a.Excerpt != "Open settings and click reset." {
		t.Fatalf("excerpt %q", a.Excerpt)
	}
	if a.Status != "draft" || a.PublishedAt != nil || a.Slug != "reset-your-password" {
		t.Fatalf("draft %+v", a)
	}
	if a.Author == nil || a.Author.ID != ws.Agent.ID.String() {
		t.Fatal("author not set")
	}

	// Derived excerpt follows the body; a manual one sticks.
	var p article
	e.Do("PATCH", "/v1/kb/articles/"+a.ID, agent, map[string]any{"body_html": "<p>New body text.</p>", "status": "published"}).Want(t, 200).JSON(t, &p)
	if p.Excerpt != "New body text." || p.PublishedAt == nil || p.Status != "published" {
		t.Fatalf("patched %+v", p)
	}
	first := *p.PublishedAt
	e.Do("PATCH", "/v1/kb/articles/"+a.ID, agent, map[string]any{"excerpt": "Hand <b>written</b>"}).Want(t, 200).JSON(t, &p)
	e.Do("PATCH", "/v1/kb/articles/"+a.ID, agent, map[string]any{"body_html": "<p>Another body.</p>"}).Want(t, 200).JSON(t, &p)
	if p.Excerpt != "Hand written" || *p.PublishedAt != first {
		t.Fatalf("manual excerpt or published_at changed: %+v", p)
	}

	b := createArticle(t, e, agent, map[string]any{"title": "Reset your password", "status": "published"})
	if b.Slug != "reset-your-password-2" || b.PublishedAt == nil {
		t.Fatalf("second %+v", b)
	}
	e.Do("PATCH", "/v1/kb/articles/"+b.ID, agent, map[string]any{"slug": "reset-your-password"}).Want(t, 409)

	// Roles and scopes.
	e.Do("GET", "/v1/kb/articles/"+a.ID, ws.Viewer.As(ws), nil).Want(t, 200)
	e.Do("PATCH", "/v1/kb/articles/"+a.ID, ws.Viewer.As(ws), map[string]any{"title": "x"}).Want(t, 403)
	readKey := e.APIKey(ws, auth.ScopeKBRead)
	e.Do("GET", "/v1/kb/articles", hdtest.Auth{Bearer: readKey}, nil).Want(t, 200)
	e.Do("POST", "/v1/kb/articles", hdtest.Auth{Bearer: readKey}, map[string]any{"title": "x"}).Want(t, 403)
	e.Do("GET", "/v1/kb/articles", hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeTicketsRead)}, nil).Want(t, 403)
	var byKey article
	e.Do("POST", "/v1/kb/articles", hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeKBWrite)}, map[string]any{"title": "By key"}).Want(t, 201).JSON(t, &byKey)
	if byKey.Author != nil {
		t.Fatal("api key article has an author")
	}

	// Filters, search and pagination.
	var page struct {
		Data       []article
		NextCursor *string `json:"next_cursor"`
	}
	e.Do("GET", "/v1/kb/articles?status=published", agent, nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 2 {
		t.Fatalf("published %d", len(page.Data))
	}
	e.Do("GET", "/v1/kb/articles?q=passw", agent, nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 2 {
		t.Fatalf("search %d", len(page.Data))
	}
	e.Do("GET", "/v1/kb/articles?limit=2", agent, nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 2 || page.NextCursor == nil {
		t.Fatalf("page1 %d %v", len(page.Data), page.NextCursor)
	}
	seen := []string{page.Data[0].ID, page.Data[1].ID}
	e.Do("GET", "/v1/kb/articles?limit=2&cursor="+*page.NextCursor, agent, nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 1 || slices.Contains(seen, page.Data[0].ID) || page.NextCursor != nil {
		t.Fatalf("page2 %+v", page)
	}

	other := e.NewWorkspace()
	e.Do("GET", "/v1/kb/articles/"+a.ID, other.Owner.As(other), nil).Want(t, 404)
	e.Do("DELETE", "/v1/kb/articles/"+a.ID, other.Owner.As(other), nil).Want(t, 404)
	e.Do("DELETE", "/v1/kb/articles/"+a.ID, agent, nil).Want(t, 204)
	e.Do("GET", "/v1/kb/articles/"+a.ID, agent, nil).Want(t, 404)
}

func TestPublicHelpCenter(t *testing.T) {
	e := hdtest.New(t, kb.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	none := hdtest.Auth{}

	var col, empty collection
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "Account"}).Want(t, 201).JSON(t, &col)
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "Empty"}).Want(t, 201).JSON(t, &empty)
	titled := createArticle(t, e, agent, map[string]any{"title": "Billing invoices", "body_html": "<p>How to download.</p>",
		"status": "published", "collection_id": col.ID})
	bodied := createArticle(t, e, agent, map[string]any{"title": "Account overview", "body_html": "<p>See billing in settings.</p>",
		"status": "published", "collection_id": col.ID})
	draft := createArticle(t, e, agent, map[string]any{"title": "Billing secret draft", "body_html": "<p>billing</p>", "collection_id": col.ID})

	base := "/v1/public/help/" + ws.Slug
	e.Do("GET", base, none, nil).Want(t, 404)
	e.Do("GET", base+"/articles/"+titled.Slug, none, nil).Want(t, 404)
	e.Do("GET", base+"/search?q=billing", none, nil).Want(t, 404)
	e.Do("GET", "/v1/public/help/no-such-workspace", none, nil).Want(t, 404)

	e.Exec(`UPDATE brands SET help_center_enabled = true, help_center_title = 'Acme help' WHERE id = $1`, ws.BrandID)
	var home struct {
		Title       string
		Collections []collection
		Featured    []article
	}
	e.Do("GET", base, none, nil).Want(t, 200).JSON(t, &home)
	if home.Title != "Acme help" || len(home.Collections) != 1 || home.Collections[0].ArticleCount != 2 || len(home.Featured) != 2 {
		t.Fatalf("home %+v", home)
	}
	for _, a := range home.Featured {
		if a.Author != nil && a.Author.Email != "" {
			t.Fatal("author email leaked")
		}
	}

	var cp struct {
		Collection collection
		Articles   []article
	}
	e.Do("GET", base+"/collections/"+col.Slug, none, nil).Want(t, 200).JSON(t, &cp)
	if len(cp.Articles) != 2 || cp.Collection.ArticleCount != 2 {
		t.Fatalf("collection %+v", cp)
	}
	e.Do("GET", base+"/articles/"+draft.Slug, none, nil).Want(t, 404)

	var got article
	e.Do("GET", base+"/articles/"+titled.Slug, none, nil).Want(t, 200)
	e.Do("GET", base+"/articles/"+titled.Slug, none, nil).Want(t, 200).JSON(t, &got)
	if got.Views != 2 || got.Author == nil || got.Author.Email != "" {
		t.Fatalf("views %d author %+v", got.Views, got.Author)
	}

	// The same slug in another collection: one article, counted once; `collection` picks.
	twin := createArticle(t, e, agent, map[string]any{"title": "Billing invoices", "slug": titled.Slug, "body_html": "<p>Twin.</p>",
		"status": "published", "collection_id": empty.ID})
	e.Do("GET", base+"/articles/"+titled.Slug, none, nil).Want(t, 200).JSON(t, &got)
	if got.ID != titled.ID || got.Views != 3 {
		t.Fatalf("by slug alone %s views %d", got.ID, got.Views)
	}
	e.Do("GET", base+"/articles/"+titled.Slug+"?collection="+empty.Slug, none, nil).Want(t, 200).JSON(t, &got)
	if got.ID != twin.ID || got.Views != 1 {
		t.Fatalf("in collection %s views %d", got.ID, got.Views)
	}
	e.Do("GET", base+"/articles/"+titled.Slug+"?collection=nope", none, nil).Want(t, 404)
	e.Exec(`DELETE FROM kb_articles WHERE id = $1`, twin.ID)

	var res []article
	e.Do("GET", base+"/search?q=billing", none, nil).Want(t, 200).JSON(t, &res)
	if len(res) != 2 || res[0].ID != titled.ID || res[1].ID != bodied.ID {
		t.Fatalf("ranking %+v", res)
	}
	e.Do("GET", base+"/search?q=bill", none, nil).Want(t, 200).JSON(t, &res)
	if len(res) != 2 {
		t.Fatalf("prefix %d", len(res))
	}
	e.Do("GET", base+"/search?q=", none, nil).Want(t, 200).JSON(t, &res)
	if len(res) != 0 {
		t.Fatal("empty q returned results")
	}
	e.Do("GET", base+"/search?q="+"%27%3A*%20%26%20%21", none, nil).Want(t, 200)

	// Disabled again: gone.
	e.Exec(`UPDATE brands SET help_center_enabled = false WHERE id = $1`, ws.BrandID)
	e.Do("GET", base, none, nil).Want(t, 404)
}

func TestHelpCenterPerBrand(t *testing.T) {
	e := hdtest.New(t, kb.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	none := hdtest.Auth{}
	other := e.NewWorkspace()

	brand := ids.New()
	slug := "shop-" + strings.ToLower(crypto.RandomString(8))
	e.Exec(`INSERT INTO brands (id, workspace_id, name, slug, help_center_enabled, help_center_title) VALUES ($1, $2, 'Shop', $3, true, 'Shop help')`,
		brand, ws.ID, slug)
	e.Exec(`UPDATE brands SET help_center_enabled = true WHERE id = $1`, ws.BrandID)

	// Brand references are checked against the workspace.
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "X", "brand_id": other.BrandID.String()}).Want(t, 422)
	e.Do("POST", "/v1/kb/articles", agent, map[string]any{"title": "X", "brand_id": "nope"}).Want(t, 422)

	var shopCol, shared collection
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "Orders", "brand_id": brand.String()}).Want(t, 201).JSON(t, &shopCol)
	if shopCol.BrandID == nil || *shopCol.BrandID != brand.String() {
		t.Fatalf("collection brand %+v", shopCol)
	}
	e.Do("POST", "/v1/kb/collections", agent, map[string]any{"name": "General"}).Want(t, 201).JSON(t, &shared)
	// In the shop's collection: the shop's, whatever its own brand says.
	inShop := createArticle(t, e, agent, map[string]any{"title": "Track an order", "status": "published", "collection_id": shopCol.ID,
		"brand_id": ws.BrandID.String()})
	// Shared collection, own brand: only that brand.
	defaultOnly := createArticle(t, e, agent, map[string]any{"title": "Desk login", "status": "published", "collection_id": shared.ID,
		"brand_id": ws.BrandID.String()})
	everyone := createArticle(t, e, agent, map[string]any{"title": "Contact us", "status": "published", "collection_id": shared.ID})

	type home struct {
		Title       string
		Collections []collection
		Featured    []article
	}
	idsOf := func(list []article) []string {
		out := []string{}
		for _, a := range list {
			out = append(out, a.ID)
		}
		slices.Sort(out)
		return out
	}
	want := func(list ...article) []string { return idsOf(list) }

	var h home
	e.Do("GET", "/v1/public/help/"+slug, none, nil).Want(t, 200).JSON(t, &h)
	if h.Title != "Shop help" || !slices.Equal(idsOf(h.Featured), want(inShop, everyone)) || len(h.Collections) != 2 {
		t.Fatalf("shop home %+v", h)
	}
	for _, c := range h.Collections {
		if c.ArticleCount != 1 {
			t.Fatalf("shop counts %+v", h.Collections)
		}
	}
	e.Do("GET", "/v1/public/help/"+ws.Slug, none, nil).Want(t, 200).JSON(t, &h)
	if !slices.Equal(idsOf(h.Featured), want(defaultOnly, everyone)) || len(h.Collections) != 1 || h.Collections[0].ArticleCount != 2 {
		t.Fatalf("default home %+v", h)
	}
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/collections/"+shopCol.Slug, none, nil).Want(t, 404)
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/articles/"+inShop.Slug, none, nil).Want(t, 404)
	e.Do("GET", "/v1/public/help/"+slug+"/articles/"+defaultOnly.Slug, none, nil).Want(t, 404)
	e.Do("GET", "/v1/public/help/"+slug+"/articles/"+inShop.Slug, none, nil).Want(t, 200)
	var res []article
	e.Do("GET", "/v1/public/help/"+slug+"/search?q=desk", none, nil).Want(t, 200).JSON(t, &res)
	if len(res) != 0 {
		t.Fatalf("search leaked %+v", res)
	}
	var cp struct {
		Collection collection
		Articles   []article
	}
	e.Do("GET", "/v1/public/help/"+slug+"/collections/"+shared.Slug, none, nil).Want(t, 200).JSON(t, &cp)
	if !slices.Equal(idsOf(cp.Articles), want(everyone)) {
		t.Fatalf("shared collection on shop %+v", cp)
	}

	// Agent filters.
	var cols struct{ Data []collection }
	e.Do("GET", "/v1/kb/collections?brand_id="+brand.String(), agent, nil).Want(t, 200).JSON(t, &cols)
	if len(cols.Data) != 1 || cols.Data[0].ID != shopCol.ID {
		t.Fatalf("collections filter %+v", cols)
	}
	e.Do("GET", "/v1/kb/collections?brand_id=none", agent, nil).Want(t, 200).JSON(t, &cols)
	if len(cols.Data) != 1 || cols.Data[0].ID != shared.ID {
		t.Fatalf("shared filter %+v", cols)
	}
	var arts struct{ Data []article }
	e.Do("GET", "/v1/kb/articles?brand_id="+brand.String(), agent, nil).Want(t, 200).JSON(t, &arts)
	if !slices.Equal(idsOf(arts.Data), want(inShop)) {
		t.Fatalf("articles filter %+v", arts)
	}
	e.Do("GET", "/v1/kb/articles?brand_id=none", agent, nil).Want(t, 200).JSON(t, &arts)
	if !slices.Equal(idsOf(arts.Data), want(everyone)) {
		t.Fatalf("shared articles filter %+v", arts)
	}
	// The composer's scope: what a brand shows, its own and shared articles.
	e.Do("GET", "/v1/kb/articles?for_brand_id="+brand.String(), agent, nil).Want(t, 200).JSON(t, &arts)
	if !slices.Equal(idsOf(arts.Data), want(inShop, everyone)) {
		t.Fatalf("for_brand_id %+v", arts)
	}
	e.Do("GET", "/v1/kb/articles?for_brand_id="+ws.BrandID.String()+"&q=desk", agent, nil).Want(t, 200).JSON(t, &arts)
	if !slices.Equal(idsOf(arts.Data), want(defaultOnly)) {
		t.Fatalf("for_brand_id search %+v", arts)
	}
	e.Do("GET", "/v1/kb/articles?for_brand_id=nope", agent, nil).Want(t, 422)
	for _, c := range []struct {
		brand *uuid.UUID
		want  []string
	}{{nil, want(inShop, defaultOnly, everyone)}, {&brand, want(inShop, everyone)}, {&ws.BrandID, want(defaultOnly, everyone)}} {
		found, err := kb.Search(e.Ctx, e.D.DB.Pool, ws.ID, "track or desk or contact", 10, c.brand)
		if err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, a := range found {
			got = append(got, a.ID.String())
		}
		slices.Sort(got)
		if !slices.Equal(got, c.want) {
			t.Fatalf("search for brand %v: %v, want %v", c.brand, got, c.want)
		}
	}

	// Clearing a collection's brand shares it with every brand.
	e.Do("PATCH", "/v1/kb/collections/"+shopCol.ID, agent, map[string]any{"brand_id": nil}).Want(t, 200).JSON(t, &shopCol)
	if shopCol.BrandID != nil {
		t.Fatalf("cleared %+v", shopCol)
	}
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/articles/"+inShop.Slug, none, nil).Want(t, 200)
	var a article
	e.Do("PATCH", "/v1/kb/articles/"+everyone.ID, agent, map[string]any{"brand_id": brand.String()}).Want(t, 200).JSON(t, &a)
	if a.BrandID == nil || *a.BrandID != brand.String() {
		t.Fatalf("article brand %+v", a)
	}
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/articles/"+everyone.Slug, none, nil).Want(t, 404)

	// A brand's help center can be off on its own.
	e.Exec(`UPDATE brands SET help_center_enabled = false WHERE id = $1`, brand)
	e.Do("GET", "/v1/public/help/"+slug, none, nil).Want(t, 404)
	e.Do("GET", "/v1/public/help/"+ws.Slug, none, nil).Want(t, 200)
}
