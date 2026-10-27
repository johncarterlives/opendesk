package brands_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/core"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/helpdesk/brands"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/widget"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/images"
)

type brandOut struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	IsDefault  bool   `json:"is_default"`
	Color      string `json:"color"`
	Locale     string `json:"locale"`
	HelpCenter struct {
		Enabled bool   `json:"enabled"`
		Title   string `json:"title"`
		URL     string `json:"url"`
	} `json:"help_center"`
	Images struct {
		Logo           *string `json:"logo"`
		HelpCenterLogo *string `json:"help_center_logo"`
	} `json:"images"`
	DefaultMailboxID *string `json:"default_mailbox_id"`
	MailboxCount     int     `json:"mailbox_count"`
	WidgetCount      int     `json:"widget_count"`
}

func pngBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for x := 0; x < 32; x++ {
		for y := 0; y < 32; y++ {
			img.Set(x, y, color.RGBA{R: 200, A: 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func uniqueSlug() string { return "brand-" + strings.ToLower(crypto.RandomString(10)) }

func TestBrandsCRUD(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	admin := ws.Admin.As(ws)
	_, seq := e.Events(ws.ID, 0)

	var list struct{ Data []brandOut }
	e.Do("GET", "/v1/brands", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || !list.Data[0].IsDefault || list.Data[0].Slug != ws.Slug || list.Data[0].WidgetCount != 1 ||
		list.Data[0].HelpCenter.URL != "http://app.test/help/"+ws.Slug {
		t.Fatalf("list %+v", list)
	}

	e.Do("POST", "/v1/brands", ws.Agent.As(ws), map[string]any{"name": "Shop"}).Want(t, 403)
	for _, bad := range []struct {
		body   map[string]any
		status int
	}{
		{map[string]any{"name": "Shop", "slug": "ab"}, 422},
		{map[string]any{"name": "Shop", "slug": "has space"}, 422},
		{map[string]any{"name": "Shop", "slug": "-dash"}, 422},
		{map[string]any{"name": "Shop", "slug": "help"}, 422},
		{map[string]any{"name": "Shop", "slug": ws.Slug}, 409},
		{map[string]any{"name": "Visit https://acme.example"}, 422},
		{map[string]any{"name": ""}, 422},
		{map[string]any{"name": strings.Repeat("a", 61)}, 422},
		{map[string]any{"name": "Shop", "color": "red"}, 422},
		{map[string]any{"name": "Shop", "locale": "not a locale"}, 422},
		{map[string]any{"name": "Shop", "help_center": map[string]any{"title": "<b>x</b>"}}, 422},
	} {
		e.Do("POST", "/v1/brands", admin, bad.body).Want(t, bad.status)
	}
	r := e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Shop", "slug": "help"})
	if !strings.Contains(string(r.Body), "slug_reserved") {
		t.Fatal(string(r.Body))
	}
	r = e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Shop", "slug": ws.Slug})
	if !strings.Contains(string(r.Body), "slug_taken") {
		t.Fatal(string(r.Body))
	}

	slug := uniqueSlug()
	var b brandOut
	e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Shop", "slug": strings.ToUpper(slug), "color": "#00AA00", "locale": "de",
		"help_center": map[string]any{"title": "Shop help"}}).Want(t, 201).JSON(t, &b)
	if b.Slug != slug || b.IsDefault || b.Color != "#00aa00" || b.Locale != "de" || !b.HelpCenter.Enabled || b.HelpCenter.Title != "Shop help" ||
		b.HelpCenter.URL != "http://app.test/help/"+slug {
		t.Fatalf("created %+v", b)
	}
	e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Shop"}).Want(t, 409)
	var derived brandOut
	e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Help"}).Want(t, 201).JSON(t, &derived)
	if derived.Slug == "help" || len(derived.Slug) < 3 {
		t.Fatalf("derived slug %q", derived.Slug)
	}

	e.Do("PATCH", "/v1/brands/"+b.ID, admin, map[string]any{"slug": ws.Slug}).Want(t, 409)
	e.Do("PATCH", "/v1/brands/"+b.ID, admin, map[string]any{"name": "Help"}).Want(t, 409)
	e.Do("PATCH", "/v1/brands/"+b.ID, ws.Agent.As(ws), map[string]any{"name": "Store"}).Want(t, 403)
	e.Do("PATCH", "/v1/brands/"+b.ID, admin, map[string]any{"name": "Store", "color": "", "help_center": map[string]any{"enabled": false}}).
		Want(t, 200).JSON(t, &b)
	if b.Name != "Store" || b.Color != "" || b.HelpCenter.Enabled {
		t.Fatalf("patched %+v", b)
	}
	e.Do("GET", "/v1/brands/"+uuid.NewString(), admin, nil).Want(t, 404)
	other := e.NewWorkspace()
	e.Do("GET", "/v1/brands/"+other.BrandID.String(), admin, nil).Want(t, 404)
	e.Do("PATCH", "/v1/brands/"+other.BrandID.String(), admin, map[string]any{"name": "Mine"}).Want(t, 404)

	types, _ := e.Events(ws.ID, seq)
	if !contains(types, "brand.created") || !contains(types, "brand.updated") {
		t.Fatalf("events %v", types)
	}
	var n int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action IN ('brand.created', 'brand.updated')`, &n, ws.ID)
	if n != 3 {
		t.Fatalf("audit %d", n)
	}
}

func TestBrandDefaultAndDelete(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	admin := ws.Admin.As(ws)

	var b brandOut
	e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Shop", "slug": uniqueSlug(), "help_center": map[string]any{"title": "Shop help"}}).
		Want(t, 201).JSON(t, &b)
	bid := uuid.MustParse(b.ID)

	// The default brand stays.
	e.Do("DELETE", "/v1/brands/"+ws.BrandID.String(), admin, nil).Want(t, 409)

	// Addresses keep a brand.
	mb := ids.New()
	e.Exec(`INSERT INTO mailboxes (id, workspace_id, name, email, inbound_kind, forwarding_token, outbound_kind, brand_id)
		VALUES ($1, $2, 'Shop', $3, 'forwarding', $4, 'system', $5)`, mb, ws.ID, "shop-"+mb.String()[:8]+"@acme.test", "fw-"+mb.String(), bid)
	e.Do("GET", "/v1/brands/"+b.ID, admin, nil).Want(t, 200).JSON(t, &b)
	if b.MailboxCount != 1 || b.DefaultMailboxID == nil || *b.DefaultMailboxID != mb.String() {
		t.Fatalf("mailboxes %+v", b)
	}
	r := e.Do("DELETE", "/v1/brands/"+b.ID, admin, nil).Want(t, 409)
	if !strings.Contains(string(r.Body), "brand_in_use") {
		t.Fatal(string(r.Body))
	}
	e.Exec(`DELETE FROM mailboxes WHERE id = $1`, mb)

	// Make it the default and back.
	e.Do("POST", "/v1/brands/"+b.ID+"/default", ws.Agent.As(ws), nil).Want(t, 403)
	e.Do("POST", "/v1/brands/"+b.ID+"/default", admin, nil).Want(t, 200).JSON(t, &b)
	if !b.IsDefault {
		t.Fatal("not default")
	}
	var list struct{ Data []brandOut }
	e.Do("GET", "/v1/brands", admin, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 2 || list.Data[0].ID != b.ID || list.Data[1].IsDefault {
		t.Fatalf("list %+v", list)
	}
	var title string
	e.Scalar(`SELECT settings->>'help_center_title' FROM workspaces WHERE id = $1`, &title, ws.ID)
	if title != "Shop help" {
		t.Fatalf("workspace help center title %q", title)
	}
	e.Do("DELETE", "/v1/brands/"+b.ID, admin, nil).Want(t, 409)
	e.Do("POST", "/v1/brands/"+ws.BrandID.String()+"/default", admin, nil).Want(t, 200)

	// Deleting takes its widgets, collections and articles; its tickets move to the default brand.
	widget := ids.New()
	e.Exec(`INSERT INTO widgets (id, workspace_id, brand_id, name, key) VALUES ($1, $2, $3, 'Shop', $4)`, widget, ws.ID, bid, "wk_"+crypto.RandomString(20))
	col := ids.New()
	e.Exec(`INSERT INTO kb_collections (id, workspace_id, name, slug, brand_id) VALUES ($1, $2, 'Orders', $3, $4)`, col, ws.ID, "orders-"+col.String()[:8], bid)
	inCol, own, shared := ids.New(), ids.New(), ids.New()
	for _, a := range []struct {
		id    uuid.UUID
		col   *uuid.UUID
		brand *uuid.UUID
	}{{inCol, &col, nil}, {own, nil, &bid}, {shared, nil, nil}} {
		e.Exec(`INSERT INTO kb_articles (id, workspace_id, collection_id, title, slug, brand_id) VALUES ($1, $2, $3, 'A', $4, $5)`,
			a.id, ws.ID, a.col, "a-"+a.id.String(), a.brand)
	}
	entry := ids.New()
	e.Exec(`INSERT INTO changelog_entries (id, workspace_id, title, slug, brand_id) VALUES ($1, $2, 'Shop update', $3, $4)`, entry, ws.ID, "u-"+entry.String(), bid)
	tk := ids.New()
	e.Exec(`INSERT INTO tickets (id, workspace_id, number, channel, brand_id, widget_id) VALUES ($1, $2, 1, 'chat', $3, $4)`, tk, ws.ID, bid, widget)
	_, seq := e.Events(ws.ID, 0)
	e.Do("DELETE", "/v1/brands/"+b.ID, ws.Agent.As(ws), nil).Want(t, 403)
	e.Do("DELETE", "/v1/brands/"+b.ID, admin, nil).Want(t, 204)
	var left int
	e.Scalar(`SELECT (SELECT count(*) FROM widgets WHERE id = $1) + (SELECT count(*) FROM kb_collections WHERE id = $2)
		+ (SELECT count(*) FROM kb_articles WHERE id = ANY($3)) + (SELECT count(*) FROM changelog_entries WHERE id = $4)`, &left, widget, col, []uuid.UUID{inCol, own}, entry)
	if left != 0 {
		t.Fatalf("%d rows left", left)
	}
	var tkBrand uuid.UUID
	e.Scalar(`SELECT brand_id FROM tickets WHERE id = $1`, &tkBrand, tk)
	e.Scalar(`SELECT count(*) FROM kb_articles WHERE id = $1`, &left, shared)
	if tkBrand != ws.BrandID || left != 1 {
		t.Fatal(tkBrand, left)
	}
	types, _ := e.Events(ws.ID, seq)
	for _, want := range []string{"brand.deleted", "widget.deleted", "kb_collection.deleted", "kb_article.deleted", "changelog_entry.deleted"} {
		if !contains(types, want) {
			t.Fatalf("events %v", types)
		}
	}
}

func TestBrandLimit(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	for i := 0; i < brands.MaxBrands-1; i++ {
		e.Exec(`INSERT INTO brands (workspace_id, name, slug) VALUES ($1, $2, $3)`, ws.ID, hdtest.Fmt("B%d", i), uniqueSlug())
	}
	r := e.Do("POST", "/v1/brands", ws.Admin.As(ws), map[string]any{"name": "One too many"}).Want(t, 422)
	if !strings.Contains(string(r.Body), "limit_reached") {
		t.Fatal(string(r.Body))
	}
}

func TestBrandImages(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	admin := ws.Admin.As(ws)
	path := "/v1/brands/" + ws.BrandID.String() + "/images/logo"
	e.UploadWith(http.MethodPut, path, ws.Agent.As(ws), "logo.png", pngBytes(t)).Want(t, 403)
	e.UploadWith(http.MethodPut, "/v1/brands/"+ws.BrandID.String()+"/images/banner", admin, "logo.png", pngBytes(t)).Want(t, 422)
	var b brandOut
	e.UploadWith(http.MethodPut, path, admin, "logo.png", pngBytes(t)).Want(t, 200).JSON(t, &b)
	if b.Images.Logo == nil || !strings.Contains(*b.Images.Logo, "/v1/images/") {
		t.Fatalf("logo %+v", b.Images)
	}
	other := e.NewWorkspace()
	e.UploadWith(http.MethodPut, "/v1/brands/"+other.BrandID.String()+"/images/logo", admin, "logo.png", pngBytes(t)).Want(t, 404)

	// The workspace's help center slots write the default brand.
	p, err := images.Process(pngBytes(t), images.Contain)
	if err != nil {
		t.Fatal(err)
	}
	o := images.Owner{Type: images.OwnerWorkspace, ID: ws.ID, WorkspaceID: &ws.ID, Slot: "help_center_logo"}
	if err := images.Set(e.Ctx, e.D, o, p, "upload", images.SetOptions{}); err != nil {
		t.Fatal(err)
	}
	e.Do("GET", "/v1/brands/"+ws.BrandID.String(), admin, nil).Want(t, 200).JSON(t, &b)
	if b.Images.HelpCenterLogo == nil {
		t.Fatalf("help center logo %+v", b.Images)
	}
	var owner string
	e.Scalar(`SELECT owner_type FROM images WHERE workspace_id = $1 AND slot = 'help_center_logo'`, &owner, ws.ID)
	if owner != "brand" {
		t.Fatal(owner)
	}
	// Brand images survive the image collector.
	e.Exec(`UPDATE images SET created_at = now() - interval '2 hours' WHERE workspace_id = $1`, ws.ID)
	if err := images.Collect(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
	var n int
	e.Scalar(`SELECT count(*) FROM images WHERE workspace_id = $1`, &n, ws.ID)
	if n != 2 {
		t.Fatalf("%d images after collect", n)
	}

	e.Do("DELETE", path, admin, nil).Want(t, 200).JSON(t, &b)
	if b.Images.Logo != nil {
		t.Fatal("logo kept")
	}
	e.Scalar(`SELECT count(*) FROM images WHERE workspace_id = $1`, &n, ws.ID)
	if n != 1 {
		t.Fatalf("%d images after delete", n)
	}
}

// The workspace's widget_key reads the default brand's first widget: changing either
// publishes workspace.updated.
func TestDefaultBrandPublishesWorkspace(t *testing.T) {
	e := hdtest.New(t, core.Register, brands.Register, widget.Register)
	ws := e.NewWorkspace()
	admin := ws.Admin.As(ws)
	var b brandOut
	e.Do("POST", "/v1/brands", admin, map[string]any{"name": "Shop", "slug": uniqueSlug()}).Want(t, 201).JSON(t, &b)
	var w struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	e.Do("POST", "/v1/widgets", admin, map[string]any{"brand_id": b.ID, "name": "Shop site"}).Want(t, 201).JSON(t, &w)

	workspaceUpdated := func(since int64) bool {
		types, _ := e.Events(ws.ID, since)
		return slices.Contains(types, "workspace.updated")
	}
	_, seq := e.Events(ws.ID, 0)
	e.Do("POST", "/v1/brands/"+b.ID+"/default", admin, nil).Want(t, 200)
	if !workspaceUpdated(seq) {
		t.Fatal("default brand change did not publish workspace.updated")
	}
	var key string
	e.Scalar(`SELECT data->'workspace'->>'widget_key' FROM events WHERE workspace_id = $1 AND type = 'workspace.updated' ORDER BY seq DESC LIMIT 1`, &key, ws.ID)
	if key != w.Key {
		t.Fatalf("widget_key %q, want the new default brand's widget %q", key, w.Key)
	}

	// Renaming the primary widget keeps the key; deleting it changes it.
	_, seq = e.Events(ws.ID, 0)
	e.Do("PATCH", "/v1/widgets/"+w.ID, admin, map[string]any{"name": "Shop"}).Want(t, 200)
	if workspaceUpdated(seq) {
		t.Fatal("a rename published workspace.updated")
	}
	e.Do("DELETE", "/v1/widgets/"+w.ID, admin, nil).Want(t, 204)
	if !workspaceUpdated(seq) {
		t.Fatal("deleting the primary widget did not publish workspace.updated")
	}
}
