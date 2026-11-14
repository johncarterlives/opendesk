package helpsite_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TestArticleAddresses: an article lives at /c/<topic>/<slug>; the address it had before
// articles lived in their topic, and every address it had since, answers 301 to the one it
// has now (contracts/api.md "Knowledge base").
func TestArticleAddresses(t *testing.T) {
	s := newSite(t, func(s *site) { s.D.Cfg.ServeWeb = true })
	base := "/help/" + s.slug
	as := s.ws.Agent.As(s.ws)
	path := s.articlePath(t)
	if !strings.HasPrefix(path, "/c/billing-") {
		t.Fatalf("path %q", path)
	}
	moved := func(from, to string) {
		t.Helper()
		r := s.get(t, "app.test", base+from+"?lang=de")
		if r.status != 301 || r.header.Get("Location") != "http://app.test"+base+to+"?lang=de" {
			t.Fatalf("%s: %d to %q, want %s", from, r.status, r.header.Get("Location"), to)
		}
	}
	slug := path[strings.LastIndex(path, "/")+1:]

	// Links from before: /a/<slug> leads to the article in its topic through the redirect the
	// migration recorded for it; an /a/ address no article had is not guessed.
	if r := s.get(t, "app.test", base+"/a/"+slug); r.status != 404 {
		t.Fatalf("/a/ with no redirect: %d", r.status)
	}
	s.Exec(`INSERT INTO kb_redirects (workspace_id, path, article_id) VALUES ($1, $2, $3)`, s.ws.ID, "/a/"+slug, s.article)
	moved("/a/"+slug, path)

	// A new slug: the old address leads to the new one.
	var art struct {
		Path string `json:"path"`
	}
	s.Do("PATCH", "/v1/kb/articles/"+s.article.String(), as, map[string]any{"slug": "refund-a-payment"}).Want(t, 200).JSON(t, &art)
	topic := path[:strings.LastIndex(path, "/")]
	if art.Path != topic+"/refund-a-payment" {
		t.Fatalf("api path %q", art.Path)
	}
	moved(path, art.Path)
	if r := s.get(t, "app.test", base+art.Path); r.status != 200 || !strings.Contains(r.body, `<link rel="canonical" href="http://app.test`+base+art.Path+`">`) {
		t.Fatalf("new address %d", r.status)
	}

	// Another topic may use the same slug; a topic's own slugs stay unique.
	var other struct {
		ID   uuid.UUID `json:"id"`
		Slug string    `json:"slug"`
	}
	s.Do("POST", "/v1/kb/collections", as, map[string]any{"name": "Payments"}).Want(t, 201).JSON(t, &other)
	var twin struct {
		ID   uuid.UUID `json:"id"`
		Path string    `json:"path"`
	}
	s.Do("POST", "/v1/kb/articles", as, map[string]any{"title": "Refunds", "slug": "refund-a-payment", "collection_id": other.ID,
		"status": "published", "body_html": "<p>Refunds in Payments</p>"}).Want(t, 201).JSON(t, &twin)
	if twin.Path != "/c/"+other.Slug+"/refund-a-payment" {
		t.Fatalf("twin path %q", twin.Path)
	}
	s.Do("POST", "/v1/kb/articles", as, map[string]any{"title": "Again", "slug": "refund-a-payment", "collection_id": other.ID}).Want(t, 409)
	// Moving into a topic where the slug is taken is refused; with a new slug it moves.
	s.Do("PATCH", "/v1/kb/articles/"+s.article.String(), as, map[string]any{"collection_id": other.ID}).Want(t, 409)
	before := art.Path
	s.Do("PATCH", "/v1/kb/articles/"+s.article.String(), as, map[string]any{"collection_id": other.ID, "slug": "refund-old-plans"}).
		Want(t, 200).JSON(t, &art)
	moved(before, art.Path)
	moved(path, art.Path) // the first address too

	// A topic's new slug: its page and its articles' old addresses lead to the new ones.
	s.Do("PATCH", "/v1/kb/collections/"+other.ID.String(), as, map[string]any{"slug": "payments-and-refunds"}).Want(t, 200)
	moved("/c/"+other.Slug, "/c/payments-and-refunds")
	moved("/c/"+other.Slug+"/refund-a-payment", "/c/payments-and-refunds/refund-a-payment")

	// Deleting a topic takes its articles out, each at a free /a/ address, led to from the old one.
	s.Do("POST", "/v1/kb/articles", as, map[string]any{"title": "Loose", "slug": "refund-a-payment", "status": "published"}).Want(t, 201)
	s.Do("DELETE", "/v1/kb/collections/"+other.ID.String(), as, nil).Want(t, 204)
	var freed string
	s.Scalar(`SELECT COALESCE('/c/' || k.slug || '/', '/a/') || a.slug FROM kb_articles a LEFT JOIN kb_collections k ON k.id = a.collection_id
		WHERE a.id = $1`, &freed, twin.ID)
	if freed != "/a/refund-a-payment-2" {
		t.Fatalf("released article %q", freed)
	}
	moved("/c/payments-and-refunds/refund-a-payment", freed)

	// The sitemap lists articles where they are, and nothing unknown redirects.
	if sm := s.get(t, "app.test", base+"/sitemap.xml"); !strings.Contains(sm.body, "<loc>http://app.test"+base+freed+"</loc>") {
		t.Fatalf("sitemap\n%s", sm.body)
	}
	for _, p := range []string{"/a/nope", "/c/nope/nope", "/c/" + topic[3:] + "/nope", "/c/a/b/c"} {
		if r := s.get(t, "app.test", base+p); r.status != 404 {
			t.Fatalf("%s: %d", p, r.status)
		}
	}
}
