package kb_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
)

type entry struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Slug        string     `json:"slug"`
	Excerpt     string     `json:"excerpt"`
	BodyHTML    string     `json:"body_html"`
	Categories  []string   `json:"categories"`
	Status      string     `json:"status"`
	PublishedAt *time.Time `json:"published_at"`
	BrandID     *string    `json:"brand_id"`
	Author      *struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"author"`
}

type entryPage struct {
	Data       []entry `json:"data"`
	NextCursor *string `json:"next_cursor"`
}

func createEntry(t *testing.T, e *hdtest.Env, a hdtest.Auth, body map[string]any) entry {
	t.Helper()
	var out entry
	e.Do("POST", "/v1/changelog/entries", a, body).Want(t, 201).JSON(t, &out)
	return out
}

func titles(es []entry) []string {
	out := []string{}
	for _, e := range es {
		out = append(out, e.Title)
	}
	return out
}

func TestChangelogEntries(t *testing.T) {
	e := hdtest.New(t, kb.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	_, seq := e.Events(ws.ID, 0)

	a := createEntry(t, e, agent, map[string]any{"title": "Dark mode", "categories": []string{" New ", "new", "Improved  UI"},
		"body_html": `<p onclick="x()">Turn it on in <strong>settings</strong>.</p><script>alert(1)</script>`})
	if strings.Contains(a.BodyHTML, "script") || strings.Contains(a.BodyHTML, "onclick") || a.Excerpt != "Turn it on in settings." {
		t.Fatalf("body or excerpt %+v", a)
	}
	if a.Status != "draft" || a.PublishedAt != nil || a.Slug != "dark-mode" || !slices.Equal(a.Categories, []string{"New", "Improved UI"}) {
		t.Fatalf("draft %+v", a)
	}
	if a.Author == nil || a.Author.ID != ws.Agent.ID.String() {
		t.Fatal("author not set")
	}

	// Publishing dates it; unpublishing and publishing again keep the date.
	var p entry
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, agent, map[string]any{"status": "published"}).Want(t, 200).JSON(t, &p)
	if p.PublishedAt == nil || time.Since(*p.PublishedAt) > time.Minute {
		t.Fatalf("published %+v", p)
	}
	first := *p.PublishedAt
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, agent, map[string]any{"status": "draft"}).Want(t, 200).JSON(t, &p)
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, agent, map[string]any{"status": "published", "categories": []string{"Fixed"}}).Want(t, 200).JSON(t, &p)
	if !p.PublishedAt.Equal(first) || !slices.Equal(p.Categories, []string{"Fixed"}) {
		t.Fatalf("republished %+v", p)
	}
	// A date given wins; null dates it again when published.
	old := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, agent, map[string]any{"published_at": old}).Want(t, 200).JSON(t, &p)
	if !p.PublishedAt.Equal(old) {
		t.Fatalf("backdated %+v", p.PublishedAt)
	}
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, agent, map[string]any{"published_at": nil}).Want(t, 200).JSON(t, &p)
	if p.PublishedAt == nil || p.PublishedAt.Equal(old) {
		t.Fatalf("null date on a published entry %+v", p.PublishedAt)
	}

	// Validation.
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "x", "categories": []string{"a", "b", "c", "d", "e", "f"}}).Want(t, 422)
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "x", "categories": []string{strings.Repeat("y", 33)}}).Want(t, 422)
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "x", "slug": "dark-mode"}).Want(t, 409)
	if s := createEntry(t, e, agent, map[string]any{"title": "Dark mode"}).Slug; s != "dark-mode-2" {
		t.Fatalf("second slug %q", s)
	}

	// Scheduled, live and draft.
	future := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	sched := createEntry(t, e, agent, map[string]any{"title": "Coming soon", "status": "published", "published_at": future, "categories": []string{"New"}})
	if !sched.PublishedAt.Equal(future) {
		t.Fatalf("scheduled %+v", sched.PublishedAt)
	}
	var list entryPage
	for status, want := range map[string][]string{"published": {"Dark mode"}, "scheduled": {"Coming soon"}, "draft": {"Dark mode"}} {
		e.Do("GET", "/v1/changelog/entries?status="+status, agent, nil).Want(t, 200).JSON(t, &list)
		if got := titles(list.Data); !slices.Equal(got, want) {
			t.Errorf("status %s: %v", status, got)
		}
	}
	e.Do("GET", "/v1/changelog/entries?category=NEW", agent, nil).Want(t, 200).JSON(t, &list)
	if got := titles(list.Data); !slices.Equal(got, []string{"Coming soon"}) {
		t.Errorf("category: %v", got)
	}
	e.Do("GET", "/v1/changelog/entries?q=soon", agent, nil).Want(t, 200).JSON(t, &list)
	if got := titles(list.Data); !slices.Equal(got, []string{"Coming soon"}) {
		t.Errorf("search: %v", got)
	}
	// Pages follow one another without gaps.
	e.Do("GET", "/v1/changelog/entries?limit=2", agent, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 2 || list.NextCursor == nil || list.Data[0].Title != "Coming soon" {
		t.Fatalf("first page %v", titles(list.Data))
	}
	var next entryPage
	e.Do("GET", "/v1/changelog/entries?limit=2&cursor="+*list.NextCursor, agent, nil).Want(t, 200).JSON(t, &next)
	if len(next.Data) != 1 || next.NextCursor != nil {
		t.Fatalf("second page %v", titles(next.Data))
	}

	var cats []struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	e.Do("GET", "/v1/changelog/categories", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &cats)
	if len(cats) != 2 || cats[0].Count != 1 {
		t.Fatalf("categories %+v", cats)
	}

	// Roles and scopes.
	e.Do("GET", "/v1/changelog/entries/"+a.ID, ws.Viewer.As(ws), nil).Want(t, 200)
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, ws.Viewer.As(ws), map[string]any{"title": "x"}).Want(t, 403)
	read := hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeChangelogRead)}
	e.Do("GET", "/v1/changelog/entries", read, nil).Want(t, 200)
	e.Do("POST", "/v1/changelog/entries", read, map[string]any{"title": "x"}).Want(t, 403)
	e.Do("GET", "/v1/changelog/entries", hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeKBWrite)}, nil).Want(t, 403)
	byKey := createEntry(t, e, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeChangelogWrite)}, map[string]any{"title": "Shipped from CI", "status": "published"})
	if byKey.Author != nil || byKey.PublishedAt == nil {
		t.Fatalf("by key %+v", byKey)
	}

	// Another workspace cannot see or change it.
	other := e.NewWorkspace()
	e.Do("GET", "/v1/changelog/entries/"+a.ID, other.Admin.As(other), nil).Want(t, 404)
	e.Do("PATCH", "/v1/changelog/entries/"+a.ID, other.Admin.As(other), map[string]any{"title": "x"}).Want(t, 404)
	e.Do("DELETE", "/v1/changelog/entries/"+a.ID, other.Admin.As(other), nil).Want(t, 404)
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "x", "brand_id": other.BrandID.String()}).Want(t, 422)

	e.Do("DELETE", "/v1/changelog/entries/"+a.ID, agent, nil).Want(t, 204)
	e.Do("GET", "/v1/changelog/entries/"+a.ID, agent, nil).Want(t, 404)
	types, _ := e.Events(ws.ID, seq)
	for _, want := range []string{"changelog_entry.created", "changelog_entry.updated", "changelog_entry.deleted"} {
		if !slices.Contains(types, want) {
			t.Errorf("missing event %s in %v", want, types)
		}
	}
}

func TestPublicChangelog(t *testing.T) {
	e := hdtest.New(t, kb.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	none := hdtest.Auth{}
	base := "/v1/public/help/" + ws.Slug + "/changelog"

	brand := uuid.New()
	slug := "shop-" + strings.ToLower(crypto.RandomString(6))
	e.Exec(`INSERT INTO brands (id, workspace_id, name, slug, help_center_enabled) VALUES ($1, $2, 'Shop', $3, true)`, brand, ws.ID, slug)

	day := func(n int) time.Time { return time.Date(2026, 1, n, 9, 0, 0, 0, time.UTC) }
	shared := createEntry(t, e, agent, map[string]any{"title": "Shared", "status": "published", "published_at": day(3), "categories": []string{"New"}})
	createEntry(t, e, agent, map[string]any{"title": "Default only", "status": "published", "published_at": day(2), "brand_id": ws.BrandID.String()})
	shop := createEntry(t, e, agent, map[string]any{"title": "Shop only", "status": "published", "published_at": day(1), "brand_id": brand.String()})
	createEntry(t, e, agent, map[string]any{"title": "Draft"})
	createEntry(t, e, agent, map[string]any{"title": "Later", "status": "published", "published_at": time.Now().Add(time.Hour)})

	// Off until the help center is on.
	e.Do("GET", base, none, nil).Want(t, 404)
	e.Exec(`UPDATE brands SET help_center_enabled = true WHERE id = $1`, ws.BrandID)

	var list entryPage
	e.Do("GET", base, none, nil).Want(t, 200).JSON(t, &list)
	if got := titles(list.Data); !slices.Equal(got, []string{"Shared", "Default only"}) {
		t.Fatalf("default brand: %v", got)
	}
	if list.Data[0].Author == nil || list.Data[0].Author.Email != "" {
		t.Fatalf("author %+v", list.Data[0].Author)
	}
	e.Do("GET", "/v1/public/help/"+slug+"/changelog", none, nil).Want(t, 200).JSON(t, &list)
	if got := titles(list.Data); !slices.Equal(got, []string{"Shared", "Shop only"}) {
		t.Fatalf("shop brand: %v", got)
	}
	e.Do("GET", base+"?limit=1", none, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.NextCursor == nil {
		t.Fatalf("first page %v", titles(list.Data))
	}
	e.Do("GET", base+"?limit=1&cursor="+*list.NextCursor, none, nil).Want(t, 200).JSON(t, &list)
	if got := titles(list.Data); !slices.Equal(got, []string{"Default only"}) {
		t.Fatalf("second page %v", got)
	}
	e.Do("GET", base+"?category=new", none, nil).Want(t, 200).JSON(t, &list)
	if got := titles(list.Data); !slices.Equal(got, []string{"Shared"}) {
		t.Fatalf("category %v", got)
	}

	var one entry
	e.Do("GET", base+"/"+shared.Slug, none, nil).Want(t, 200).JSON(t, &one)
	if one.ID != shared.ID {
		t.Fatalf("entry %+v", one)
	}
	e.Do("GET", base+"/"+shop.Slug, none, nil).Want(t, 404)
	e.Do("GET", base+"/draft", none, nil).Want(t, 404)
	e.Do("GET", base+"/later", none, nil).Want(t, 404)

	// A deleted brand takes its entries with it.
	e.Exec(`DELETE FROM brands WHERE id = $1`, brand)
	e.Do("GET", "/v1/changelog/entries/"+shop.ID, agent, nil).Want(t, 404)
}
