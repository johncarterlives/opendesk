package helpsite_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

const pngBytes = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"

// file stores an object and its attachments row in the site's workspace, held by the
// article or changelog entry named by col and owner (none when col is "").
func (s *site) file(t *testing.T, contentType, body, col string, owner uuid.UUID) uuid.UUID {
	t.Helper()
	id := uuid.New()
	key := "test/" + id.String()
	if err := s.D.Storage.Put(s.Ctx, key, strings.NewReader(body), int64(len(body)), contentType); err != nil {
		t.Fatal(err)
	}
	s.Exec(`INSERT INTO attachments (id, workspace_id, filename, content_type, size_bytes, storage_key) VALUES ($1, $2, 'chart.png', $3, $4, $5)`,
		id, s.ws.ID, contentType, len(body), key)
	if col != "" {
		s.Exec(`UPDATE attachments SET `+col+` = $2 WHERE id = $1`, id, owner)
	}
	return id
}

// The help center serves the images of its published articles and changelog entries at
// /_help/files/<id>, and nothing else.
func TestHelpCenterFiles(t *testing.T) {
	s := newSite(t, func(s *site) { s.D.Cfg.ServeWeb = true })
	root := "/help/" + s.slug
	files := root + "/_help/files/"

	shown := s.file(t, "image/png", pngBytes, "kb_article_id", s.article)
	r := s.get(t, "app.test", files+shown.String())
	if r.status != 200 || r.body != pngBytes {
		t.Fatalf("a published article's image: %d %q", r.status, r.body)
	}
	for k, v := range map[string]string{"Content-Type": "image/png", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "cross-origin"} {
		if got := r.header.Get(k); got != v {
			t.Fatalf("%s: %q, want %q", k, got, v)
		}
	}

	var draft, otherBrand uuid.UUID
	s.Scalar(`SELECT id FROM kb_articles WHERE workspace_id = $1 AND status = 'draft'`, &draft, s.ws.ID)
	brand := uuid.New()
	s.Exec(`INSERT INTO brands (id, workspace_id, name, slug) VALUES ($1, $2, 'Other', $3)`, brand, s.ws.ID, "other-"+s.slug)
	s.Scalar(`INSERT INTO kb_articles (workspace_id, title, slug, status, published_at, brand_id) VALUES ($1, 'Theirs', 'theirs', 'published', now(), $2) RETURNING id`,
		&otherBrand, s.ws.ID, brand)
	var future, past uuid.UUID
	s.Scalar(`INSERT INTO changelog_entries (workspace_id, title, slug, status, published_at) VALUES ($1, 'Soon', 'soon', 'published', now() + interval '1 day') RETURNING id`, &future, s.ws.ID)
	s.Scalar(`INSERT INTO changelog_entries (workspace_id, title, slug, body_html, status, published_at) VALUES ($1, 'Shipped', 'shipped', '', 'published', now() - interval '1 day') RETURNING id`, &past, s.ws.ID)

	entryImage := s.file(t, "image/png", pngBytes, "changelog_entry_id", past)
	if r := s.get(t, "app.test", files+entryImage.String()); r.status != 200 {
		t.Fatalf("a published changelog entry's image: %d", r.status)
	}
	for name, id := range map[string]uuid.UUID{
		"a draft's image":              s.file(t, "image/png", pngBytes, "kb_article_id", draft),
		"another brand's image":        s.file(t, "image/png", pngBytes, "kb_article_id", otherBrand),
		"a scheduled entry's image":    s.file(t, "image/png", pngBytes, "changelog_entry_id", future),
		"a published article's script": s.file(t, "text/plain", "alert(1)", "kb_article_id", s.article),
		"a file nothing holds":         s.file(t, "image/png", pngBytes, "", uuid.Nil),
		"no such file":                 uuid.New(),
	} {
		if r := s.get(t, "app.test", files+id.String()); r.status != 404 || r.body == pngBytes {
			t.Fatalf("%s: %d", name, r.status)
		}
	}
	if r := s.get(t, "app.test", files+"not-a-uuid"); r.status != 404 {
		t.Fatalf("a bad id: %d", r.status)
	}
	s.Exec(`UPDATE kb_articles SET status = 'draft' WHERE id = $1`, s.article)
	if r := s.get(t, "app.test", files+shown.String()); r.status != 404 {
		t.Fatalf("an unpublished article's image: %d", r.status)
	}
	s.Exec(`UPDATE kb_articles SET status = 'published' WHERE id = $1`, s.article)
	s.Exec(`UPDATE brands SET help_center_enabled = false WHERE id = $1`, s.brandID)
	if r := s.get(t, "app.test", files+shown.String()); r.status != 404 {
		t.Fatalf("a help center that is off: %d", r.status)
	}
}

// A body saved before images were kept as plain paths names them by a signed link that has
// since expired: pages and the feed show them from the help center's own address.
func TestOldSignedLinksRenderStable(t *testing.T) {
	s := newSite(t, func(s *site) { s.D.Cfg.ServeWeb = true })
	base := "http://app.test/help/" + s.slug
	id := s.file(t, "image/png", pngBytes, "kb_article_id", s.article)
	old := `<p><img src="http://api.test/v1/attachments/` + id.String() + `?exp=1&amp;sig=abc"></p>`
	s.Exec(`UPDATE kb_articles SET body_html = $2 WHERE id = $1`, s.article, old)
	s.Exec(`INSERT INTO changelog_entries (workspace_id, title, slug, body_html, status, published_at) VALUES ($1, 'Shipped', 'shipped', $2, 'published', now())`,
		s.ws.ID, old)
	want := `src="` + base + `/_help/files/` + id.String() + `"`

	for _, path := range []string{s.articlePath(t), "/changelog", "/changelog/shipped", "/changelog/feed.xml"} {
		r := s.get(t, "app.test", "/help/"+s.slug+path)
		body := strings.ReplaceAll(r.body, "&#34;", `"`)
		body = strings.ReplaceAll(body, "&quot;", `"`)
		if r.status != 200 || !strings.Contains(body, want) || strings.Contains(body, "sig=") {
			t.Fatalf("%s: %d\n%s", path, r.status, r.body)
		}
	}
	if r := s.get(t, "app.test", "/help/"+s.slug+"/_help/files/"+id.String()); r.status != 200 {
		t.Fatalf("the image itself: %d", r.status)
	}
}

// An image two articles show stays on the help center when the one holding it is deleted:
// it passes to the other (a published one before an older draft), and the sweep keeps it.
// The same goes for changelog entries.
func TestHelpCenterFileHandedOver(t *testing.T) {
	s := newSite(t, func(s *site) { s.D.Cfg.ServeWeb = true })
	agent := s.ws.Agent.As(s.ws)
	files := "/help/" + s.slug + "/_help/files/"
	id := s.file(t, "image/png", pngBytes, "kb_article_id", s.article)
	// The second article names it in upper case, as an older body may.
	body := `<p><img src="/v1/attachments/` + id.String() + `"></p>`
	upper := `<p><img src="/v1/attachments/` + strings.ToUpper(id.String()) + `"></p>`
	var second, draft uuid.UUID
	s.Exec(`UPDATE kb_articles SET body_html = $2 WHERE id = $1`, s.article, body)
	s.Scalar(`SELECT id FROM kb_articles WHERE workspace_id = $1 AND title = 'Change your plan'`, &second, s.ws.ID)
	s.Exec(`UPDATE kb_articles SET body_html = $2 WHERE id = $1`, second, upper)
	s.Scalar(`INSERT INTO kb_articles (workspace_id, title, slug, body_html, status, created_at) VALUES ($1, 'Old draft', 'old-draft', $2, 'draft', now() - interval '1 year') RETURNING id`,
		&draft, s.ws.ID, body)
	s.Exec(`UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = $1`, id)

	s.Do("DELETE", "/v1/kb/articles/"+s.article.String(), agent, nil).Want(t, 204)
	var holder *uuid.UUID
	s.Scalar(`SELECT kb_article_id FROM attachments WHERE id = $1`, &holder, id)
	if holder == nil || *holder != second {
		t.Fatalf("held by %v, want the published article %s", holder, second)
	}
	if err := tickets.PurgeAttachments(s.Ctx, s.D); err != nil {
		t.Fatal(err)
	}
	if r := s.get(t, "app.test", files+id.String()); r.status != 200 || r.body != pngBytes {
		t.Fatalf("after the first article went: %d", r.status)
	}

	// An edit that drops it hands it over too; with no article left naming it, an entry may.
	s.Do("DELETE", "/v1/kb/articles/"+draft.String(), agent, nil).Want(t, 204)
	var entry uuid.UUID
	s.Scalar(`INSERT INTO changelog_entries (workspace_id, title, slug, body_html, status, published_at) VALUES ($1, 'Shipped', 'shipped', $2, 'published', now()) RETURNING id`,
		&entry, s.ws.ID, body)
	s.Do("PATCH", "/v1/kb/articles/"+second.String(), agent, map[string]any{"body_html": "<p>No image</p>"}).Want(t, 200)
	s.Scalar(`SELECT changelog_entry_id FROM attachments WHERE id = $1`, &holder, id)
	if holder == nil || *holder != entry {
		t.Fatalf("held by %v, want the entry %s", holder, entry)
	}
	if r := s.get(t, "app.test", files+id.String()); r.status != 200 {
		t.Fatalf("the entry's image: %d", r.status)
	}

	// Nobody naming it once the entry is gone, the sweep removes it.
	s.Do("DELETE", "/v1/changelog/entries/"+entry.String(), agent, nil).Want(t, 204)
	if err := tickets.PurgeAttachments(s.Ctx, s.D); err != nil {
		t.Fatal(err)
	}
	var n int
	s.Scalar(`SELECT count(*) FROM attachments WHERE id = $1`, &n, id)
	if n != 0 {
		t.Fatal("a file nothing names was kept")
	}
}

// The help center serves an image some article or entry holds whenever a body it shows as
// published names it, whoever holds it: a draft or an entry never hides it from a published
// article. A file no save claimed, or one only a draft or another brand names, stays hidden.
func TestHelpCenterFileNamedByPublished(t *testing.T) {
	s := newSite(t, func(s *site) { s.D.Cfg.ServeWeb = true })
	files := "/help/" + s.slug + "/_help/files/"
	var draft, entry uuid.UUID
	s.Scalar(`SELECT id FROM kb_articles WHERE workspace_id = $1 AND status = 'draft'`, &draft, s.ws.ID)
	s.Scalar(`INSERT INTO changelog_entries (workspace_id, title, slug, status) VALUES ($1, 'Next', 'next', 'draft') RETURNING id`, &entry, s.ws.ID)
	brand := uuid.New()
	s.Exec(`INSERT INTO brands (id, workspace_id, name, slug) VALUES ($1, $2, 'Other', $3)`, brand, s.ws.ID, "other-"+s.slug)

	byDraft := s.file(t, "image/png", pngBytes, "kb_article_id", draft)
	byEntry := s.file(t, "image/png", pngBytes, "changelog_entry_id", entry)
	draftOnly := s.file(t, "image/png", pngBytes, "kb_article_id", draft)
	otherBrand := s.file(t, "image/png", pngBytes, "kb_article_id", draft)
	unclaimed := s.file(t, "image/png", pngBytes, "", uuid.Nil)
	img := func(ids ...uuid.UUID) string {
		out := ""
		for _, id := range ids {
			out += `<img src="/v1/attachments/` + id.String() + `">`
		}
		return out
	}
	// The published article names its images in upper case, as an older body may.
	s.Exec(`UPDATE kb_articles SET body_html = $2 WHERE id = $1`, s.article, strings.ToUpper(img(byDraft, byEntry, unclaimed)))
	s.Exec(`UPDATE kb_articles SET body_html = $2 WHERE id = $1`, draft, img(byDraft, draftOnly, otherBrand))
	s.Exec(`INSERT INTO kb_articles (workspace_id, title, slug, body_html, status, published_at, brand_id) VALUES ($1, 'Theirs', 'theirs', $2, 'published', now(), $3)`,
		s.ws.ID, img(otherBrand), brand)

	for name, c := range map[string]struct {
		id   uuid.UUID
		want int
	}{
		"a draft holds it, a published article names it":    {byDraft, 200},
		"an entry holds it, a published article names it":   {byEntry, 200},
		"a draft holds it, nothing published names it":      {draftOnly, 404},
		"only another brand's published article names it":   {otherBrand, 404},
		"a published article names it, but no save claimed": {unclaimed, 404},
	} {
		if r := s.get(t, "app.test", files+c.id.String()); r.status != c.want {
			t.Fatalf("%s: %d, want %d", name, r.status, c.want)
		}
	}
	s.Exec(`UPDATE kb_articles SET status = 'draft' WHERE id = $1`, s.article)
	if r := s.get(t, "app.test", files+byDraft.String()); r.status != 404 {
		t.Fatalf("once the article naming it is unpublished: %d", r.status)
	}
}
