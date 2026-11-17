package kb_test

import (
	"html"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/helpdesk/widget"
	"github.com/useopendesk/opendesk/internal/helpdesk/wiki"
)

const pngBytes = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"

type upload struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

func uploadPNG(t *testing.T, e *hdtest.Env, a hdtest.Auth) upload {
	t.Helper()
	var f upload
	e.Upload("/v1/attachments", a, "chart.png", []byte(pngBytes)).Want(t, 201).JSON(t, &f)
	if !strings.Contains(f.URL, "sig=") {
		t.Fatalf("upload url %q is not signed", f.URL)
	}
	return f
}

// img is the tag an editor inserts: the signed URL the upload returned.
func img(f upload) string { return `<p><img src="` + html.EscapeString(f.URL) + `" alt="chart"></p>` }

func holderOf(t *testing.T, e *hdtest.Env, col, file string) *uuid.UUID {
	t.Helper()
	var id *uuid.UUID
	e.Scalar(`SELECT `+col+` FROM attachments WHERE id = $1`, &id, file)
	return id
}

func TestArticleFiles(t *testing.T) {
	e := hdtest.New(t, kb.Register, widget.Register)
	ws := e.NewWorkspace()
	agent, admin := ws.Agent.As(ws), ws.Admin.As(ws)
	file := uploadPNG(t, e, agent)

	// Saving keeps the file as its plain path and makes it the article's own.
	art := createArticle(t, e, agent, map[string]any{"title": "Charts", "body_html": img(file)})
	var stored string
	e.Scalar(`SELECT body_html FROM kb_articles WHERE id = $1`, &stored, art.ID)
	if strings.Contains(stored, "sig=") || strings.Contains(stored, "api.test") || !strings.Contains(stored, `src="/v1/attachments/`+file.ID+`"`) {
		t.Fatalf("stored body %s", stored)
	}
	if h := holderOf(t, e, "kb_article_id", file.ID); h == nil || h.String() != art.ID {
		t.Fatalf("file held by %v, want %s", h, art.ID)
	}

	// Every member's read signs it, so the editor shows the image; any member may open it.
	signed := `src="http://api.test/v1/attachments/` + file.ID + `?exp=`
	var got article
	e.Do("GET", "/v1/kb/articles/"+art.ID, admin, nil).Want(t, 200).JSON(t, &got)
	if !strings.Contains(got.BodyHTML, signed) || !strings.Contains(got.BodyHTML, "&amp;sig=") {
		t.Fatalf("editor read %s", got.BodyHTML)
	}
	if !strings.Contains(art.BodyHTML, signed) {
		t.Fatalf("create answered %s", art.BodyHTML)
	}
	var list struct{ Data []article }
	e.Do("GET", "/v1/kb/articles", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || !strings.Contains(list.Data[0].BodyHTML, signed) {
		t.Fatalf("list %+v", list.Data)
	}
	e.Do("GET", "/v1/attachments/"+file.ID, admin, nil).Want(t, 200)
	e.Do("GET", "/v1/attachments/"+file.ID, ws.Viewer.As(ws), nil).Want(t, 200)
	e.Do("GET", "/v1/attachments/"+file.ID, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeKBRead)}, nil).Want(t, 200)
	e.Do("GET", "/v1/attachments/"+file.ID, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeTicketsRead)}, nil).Want(t, 404)

	// A signed link pasted in an edit is stored plain too; dropping the image lets go of it.
	e.Do("PATCH", "/v1/kb/articles/"+art.ID, admin, map[string]any{"body_html": got.BodyHTML}).Want(t, 200)
	e.Scalar(`SELECT body_html FROM kb_articles WHERE id = $1`, &stored, art.ID)
	if strings.Contains(stored, "sig=") || holderOf(t, e, "kb_article_id", file.ID) == nil {
		t.Fatalf("after an edit by another member: %s", stored)
	}
	e.Do("PATCH", "/v1/kb/articles/"+art.ID, agent, map[string]any{"body_html": "<p>No chart</p>"}).Want(t, 200)
	if h := holderOf(t, e, "kb_article_id", file.ID); h != nil {
		t.Fatalf("a file the body dropped is still held by %v", h)
	}
	e.Do("PATCH", "/v1/kb/articles/"+art.ID, agent, map[string]any{"body_html": img(file)}).Want(t, 200)
	if h := holderOf(t, e, "kb_article_id", file.ID); h == nil || h.String() != art.ID {
		t.Fatalf("put back, held by %v", h)
	}

	// The public API hands out the help center's own address, for good.
	e.Exec(`UPDATE brands SET help_center_enabled = true WHERE id = $1`, ws.BrandID)
	e.Do("PATCH", "/v1/kb/articles/"+art.ID, agent, map[string]any{"status": "published"}).Want(t, 200)
	stable := `src="http://app.test/help/` + ws.Slug + `/_help/files/` + file.ID + `"`
	var pub article
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/articles/"+art.Slug, hdtest.Auth{}, nil).Want(t, 200).JSON(t, &pub)
	if !strings.Contains(pub.BodyHTML, stable) || strings.Contains(pub.BodyHTML, "sig=") {
		t.Fatalf("public article %s", pub.BodyHTML)
	}
	var found []article
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/search?q=charts", hdtest.Auth{}, nil).Want(t, 200).JSON(t, &found)
	if len(found) != 1 || !strings.Contains(found[0].BodyHTML, stable) {
		t.Fatalf("search %+v", found)
	}
	var home struct{ Featured []article }
	e.Do("GET", "/v1/public/help/"+ws.Slug, hdtest.Auth{}, nil).Want(t, 200).JSON(t, &home)
	if len(home.Featured) != 1 || !strings.Contains(home.Featured[0].BodyHTML, stable) {
		t.Fatalf("featured %+v", home.Featured)
	}

	// The sweep of old uploads keeps the article's file, and frees it once the article is gone.
	e.Exec(`UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = $1`, file.ID)
	if err := tickets.PurgeAttachments(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
	var n int
	e.Scalar(`SELECT count(*) FROM attachments WHERE id = $1`, &n, file.ID)
	if n != 1 {
		t.Fatal("the sweep removed an article's file")
	}
	e.Do("DELETE", "/v1/kb/articles/"+art.ID, agent, nil).Want(t, 204)
	if err := tickets.PurgeAttachments(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
	e.Scalar(`SELECT count(*) FROM attachments WHERE id = $1`, &n, file.ID)
	if n != 0 {
		t.Fatal("a deleted article's file was kept")
	}
}

// Only the saver's own uploads that nothing else holds become an article's: naming another
// member's upload (one meant for a ticket) claims nothing and opens nothing.
func TestArticleCannotClaimOthersFiles(t *testing.T) {
	e := hdtest.New(t, kb.Register, widget.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	theirs := uploadPNG(t, e, ws.Admin.As(ws))
	drafted := uploadPNG(t, e, agent)
	var ticket uuid.UUID
	e.Scalar(`INSERT INTO tickets (workspace_id, number, brand_id, channel, subject) VALUES ($1, 1, $2, 'api', 'Help') RETURNING id`, &ticket, ws.ID, ws.BrandID)
	e.Exec(`INSERT INTO ticket_reply_drafts (workspace_id, ticket_id, user_id, body_html, body_text, attachment_ids) VALUES ($1, $2, $3, '', '', $4)`,
		ws.ID, ticket, ws.Agent.ID, []string{drafted.ID})

	body := `<p><img src="/v1/attachments/` + theirs.ID + `"><img src="/v1/attachments/` + drafted.ID + `"></p>`
	art := createArticle(t, e, agent, map[string]any{"title": "Borrowed", "body_html": body, "status": "published"})
	for _, f := range []string{theirs.ID, drafted.ID} {
		if h := holderOf(t, e, "kb_article_id", f); h != nil {
			t.Fatalf("file %s claimed by %v", f, h)
		}
		if strings.Contains(art.BodyHTML, f+"?exp=") {
			t.Fatalf("an unclaimed file came back signed: %s", art.BodyHTML)
		}
	}
	e.Do("GET", "/v1/attachments/"+theirs.ID, agent, nil).Want(t, 404)
	var entry struct{ ID string }
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "Borrowed too", "body_html": body}).Want(t, 201).JSON(t, &entry)
	if h := holderOf(t, e, "changelog_entry_id", theirs.ID); h != nil {
		t.Fatalf("an entry claimed another member's upload: %v", h)
	}
}

func TestChangelogFiles(t *testing.T) {
	e := hdtest.New(t, kb.Register, widget.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	file := uploadPNG(t, e, agent)
	var entry struct {
		ID       string `json:"id"`
		Slug     string `json:"slug"`
		BodyHTML string `json:"body_html"`
	}
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "New charts", "body_html": img(file), "status": "published"}).
		Want(t, 201).JSON(t, &entry)
	var stored string
	e.Scalar(`SELECT body_html FROM changelog_entries WHERE id = $1`, &stored, entry.ID)
	if strings.Contains(stored, "sig=") || holderOf(t, e, "changelog_entry_id", file.ID) == nil {
		t.Fatalf("stored %s", stored)
	}
	if !strings.Contains(entry.BodyHTML, `/v1/attachments/`+file.ID+`?exp=`) {
		t.Fatalf("create answered %s", entry.BodyHTML)
	}
	e.Do("GET", "/v1/attachments/"+file.ID, hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeChangelogRead)}, nil).Want(t, 200)

	e.Exec(`UPDATE brands SET help_center_enabled = true WHERE id = $1`, ws.BrandID)
	stable := `src="http://app.test/help/` + ws.Slug + `/_help/files/` + file.ID + `"`
	var pub struct {
		BodyHTML string `json:"body_html"`
	}
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/changelog/"+entry.Slug, hdtest.Auth{}, nil).Want(t, 200).JSON(t, &pub)
	if !strings.Contains(pub.BodyHTML, stable) {
		t.Fatalf("public entry %s", pub.BodyHTML)
	}
	var page struct {
		Data []struct {
			BodyHTML string `json:"body_html"`
		}
	}
	e.Do("GET", "/v1/public/help/"+ws.Slug+"/changelog", hdtest.Auth{}, nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 1 || !strings.Contains(page.Data[0].BodyHTML, stable) {
		t.Fatalf("public changelog %+v", page.Data)
	}
}

// A file an article holds stays the article's: a reply naming it in attachment_ids is
// refused, and a message added with it does not take it, so the help center keeps serving it.
func TestArticleFileStaysOffReplies(t *testing.T) {
	e := hdtest.New(t, kb.Register, widget.Register, tickets.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	file := uploadPNG(t, e, agent)
	art := createArticle(t, e, agent, map[string]any{"title": "Charts", "body_html": img(file), "status": "published"})
	var tk domain.Ticket
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		var err error
		tk, err = domain.CreateTicket(e.Ctx, tx, domain.NewTicket{WorkspaceID: ws.ID, Channel: domain.ChannelAPI, Subject: "Help"})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages", agent, map[string]any{"kind": "reply", "body_html": "x", "attachment_ids": []string{file.ID}}).Want(t, 422)
	err = e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		_, err := domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: ws.ID, TicketID: tk.ID, Kind: "reply", Direction: "outbound",
			AuthorType: "user", AuthorUserID: &ws.Agent.ID, BodyText: "x", BodyHTML: "<p>x</p>", Trigger: "none", AttachmentIDs: []uuid.UUID{uuid.MustParse(file.ID)}})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if h := holderOf(t, e, "kb_article_id", file.ID); h == nil || h.String() != art.ID {
		t.Fatalf("file held by %v, want %s", h, art.ID)
	}
	if h := holderOf(t, e, "message_id", file.ID); h != nil {
		t.Fatalf("a message took the article's file: %v", h)
	}
}

// An image copied from an article into a wiki page loads there too: any member reads an
// article's files, so the page's read signs it.
func TestArticleFileInWikiPage(t *testing.T) {
	e := hdtest.New(t, kb.Register, widget.Register, wiki.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	file := uploadPNG(t, e, agent)
	createArticle(t, e, agent, map[string]any{"title": "Charts", "body_html": img(file)})
	var pg struct {
		ID       string `json:"id"`
		BodyHTML string `json:"body_html"`
	}
	e.Do("POST", "/v1/wiki/pages", ws.Admin.As(ws), map[string]any{"title": "Notes", "body_html": `<p><img src="/v1/attachments/` + file.ID + `"></p>`}).
		Want(t, 201).JSON(t, &pg)
	if h := holderOf(t, e, "wiki_page_id", file.ID); h != nil {
		t.Fatalf("the page took the article's file: %v", h)
	}
	e.Do("GET", "/v1/wiki/pages/"+pg.ID, ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &pg)
	if !strings.Contains(pg.BodyHTML, `src="http://api.test/v1/attachments/`+file.ID+`?exp=`) {
		t.Fatalf("page read %s", pg.BodyHTML)
	}
}

// An article's editor shows an image another article or an entry holds: any member reads it.
func TestArticleSignsFilesOthersHold(t *testing.T) {
	e := hdtest.New(t, kb.Register, widget.Register)
	ws := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	file := uploadPNG(t, e, agent)
	var entry struct{ ID string }
	e.Do("POST", "/v1/changelog/entries", agent, map[string]any{"title": "New charts", "body_html": img(file)}).Want(t, 201).JSON(t, &entry)
	art := createArticle(t, e, ws.Admin.As(ws), map[string]any{"title": "Charts", "body_html": `<p><img src="/v1/attachments/` + file.ID + `"></p>`})
	if h := holderOf(t, e, "changelog_entry_id", file.ID); h == nil || h.String() != entry.ID {
		t.Fatalf("file held by %v, want the entry", h)
	}
	if !strings.Contains(art.BodyHTML, `src="http://api.test/v1/attachments/`+file.ID+`?exp=`) {
		t.Fatalf("article read %s", art.BodyHTML)
	}
}
