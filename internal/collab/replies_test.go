package collab

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/ids"
)

// Replies to a comment (contracts/collab.md "Replies").

func reply(t *testing.T, srv *httptest.Server, tid, parent uuid.UUID, html string) (MailComment, int) {
	t.Helper()
	var c MailComment
	st := doJSON(t, "POST", srv.URL+"/v1/collab/threads/"+tid.String()+"/comments", map[string]any{"body_html": html, "reply_to": parent}, &c)
	return c, st
}

func commentsOf(t *testing.T, srv *httptest.Server, tid uuid.UUID) map[uuid.UUID]MailComment {
	t.Helper()
	var d MailThreadDetail
	if st := doJSON(t, "GET", srv.URL+"/v1/collab/threads/"+tid.String(), nil, &d); st != 200 {
		t.Fatalf("detail: %d", st)
	}
	out := map[uuid.UUID]MailComment{}
	for _, c := range d.Comments {
		out[c.ID] = c
	}
	return out
}

func TestAPICommentReplyStaysInItsConversation(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityShared, everyone)
	tid, _ := w.seedThread(a, "Refund question", w.folder(a, RoleInbox))
	other, _ := w.seedThread(a, "Invoice", w.folder(a, RoleInbox))
	adam, bea := w.api(w.agent), w.api(w.agent2)

	elsewhere := comment(t, bea, other, "On the invoice")
	// Another workspace's comment, on a conversation of its own.
	w2 := newWorld(t)
	a2 := w2.account(w2.agent, ProviderGoogle, VisibilityShared, everyone)
	tid2, _ := w2.seedThread(a2, "Theirs", w2.folder(a2, RoleInbox))
	foreign := comment(t, w2.api(w2.agent), tid2, "Not yours")

	for name, parent := range map[string]uuid.UUID{"another conversation": elsewhere.ID, "another workspace": foreign.ID, "no comment": ids.New()} {
		if _, st := reply(t, adam, tid, parent, "<p>Answer</p>"); st != 422 {
			t.Fatalf("reply to %s: %d, want 422", name, st)
		}
	}
	if n := w.count(`SELECT count(*) FROM collab_comments WHERE thread_id = $1`, tid); n != 0 {
		t.Fatalf("a refused reply was stored: %d", n)
	}
	// The database refuses it too, whatever writes it.
	if _, err := w.d.DB.Pool.Exec(context.Background(), `INSERT INTO collab_comments (id, workspace_id, thread_id, author_id, body_html, reply_to, replied)
		VALUES ($1, $2, $3, $4, '<p>x</p>', $5, true)`, ids.New(), w.wid, tid, w.agent.UserID, elsewhere.ID); err == nil {
		t.Fatal("database stored a reply to another conversation's comment")
	}

	// A reply in the same conversation keeps its parent and quotes its first line.
	parent := comment(t, bea, tid, "Customer wants a refund.<br>Second line")
	mustExec(t, w.d, `UPDATE collab_comments SET body_html = '<p>Customer wants a refund.</p><p>Second line</p>' WHERE id = $1`, parent.ID)
	c, st := reply(t, adam, tid, parent.ID, "<p>On it</p>")
	if st != 200 || c.ReplyTo == nil || *c.ReplyTo != parent.ID || c.Parent == nil || c.ParentDeleted {
		t.Fatalf("reply: %d %+v", st, c)
	}
	if c.Parent.Author == nil || c.Parent.Author.ID != w.agent2.UserID || c.Parent.Excerpt != "Customer wants a refund." {
		t.Fatalf("parent quote: %+v", c.Parent)
	}
	got := commentsOf(t, bea, tid)[c.ID]
	if got.ReplyTo == nil || *got.ReplyTo != parent.ID || got.Parent == nil || got.Parent.Excerpt != "Customer wants a refund." {
		t.Fatalf("listed reply: %+v", got)
	}
	if plain := commentsOf(t, bea, tid)[parent.ID]; plain.ReplyTo != nil || plain.Parent != nil || plain.ParentDeleted {
		t.Fatalf("a comment that replies to nothing: %+v", plain)
	}

	// Deleting the parent keeps the reply, which says the original was deleted.
	if st := doJSON(t, "DELETE", bea.URL+"/v1/collab/comments/"+parent.ID.String(), nil, nil); st != 204 {
		t.Fatalf("delete parent: %d", st)
	}
	got = commentsOf(t, adam, tid)[c.ID]
	if got.ID != c.ID || got.ReplyTo != nil || got.Parent != nil || !got.ParentDeleted {
		t.Fatalf("reply after its parent was deleted: %+v", got)
	}
}

func TestAPICommentReplyFollowsAndNotifiesItsAuthor(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityShared, everyone)
	tid, _ := w.seedThread(a, "Refund question", w.folder(a, RoleInbox))
	adam, bea, olive := w.api(w.agent), w.api(w.agent2), w.api(w.owner)
	unfollow := func(srv *httptest.Server) {
		t.Helper()
		if st := doJSON(t, "DELETE", srv.URL+"/v1/collab/threads/"+tid.String()+"/follow", nil, nil); st != 204 {
			t.Fatalf("unfollow: %d", st)
		}
	}
	notified := func(uid uuid.UUID, cid uuid.UUID) int {
		return w.count(`SELECT count(*) FROM notifications WHERE workspace_id = $1 AND user_id = $2 AND type = 'collab_mention'
			AND data->>'comment_id' = $3`, w.wid, uid, cid.String())
	}

	beas := comment(t, bea, tid, "Should we refund?")
	comment(t, olive, tid, "Yes, I think so.")
	unfollow(bea)
	unfollow(olive)
	wantMentions(t, bea, "Bea")

	// Adam answers Bea's comment, after Olive's: the reply link brings Bea back and tells her,
	// and Olive, whom a plain comment would have answered, is left out.
	c, st := reply(t, adam, tid, beas.ID, "<p>Refunded.</p>")
	if st != 200 {
		t.Fatalf("reply: %d", st)
	}
	wantMentions(t, bea, "Bea", tid)
	wantMentions(t, olive, "Olive")
	if n := notified(w.agent2.UserID, c.ID); n != 1 {
		t.Fatalf("Bea's notifications = %d, want 1", n)
	}
	if n := w.count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND data->>'reply_to' = $2`, w.agent2.UserID, beas.ID.String()); n != 1 {
		t.Fatalf("notification does not name the comment answered: %d", n)
	}
	if n := notified(w.owner.UserID, c.ID); n != 0 {
		t.Fatalf("Olive was told of a reply to Bea: %d", n)
	}

	// A reply that also mentions her tells her once.
	both, st := reply(t, adam, tid, beas.ID, `<p>And <span data-type="mention" data-id="`+w.agent2.UserID.String()+`">@Bea</span>, thanks</p>`)
	if st != 200 || notified(w.agent2.UserID, both.ID) != 1 {
		t.Fatalf("reply with a mention: %d, %d notifications", st, notified(w.agent2.UserID, both.ID))
	}

	// Answering your own comment follows and tells no one.
	adams := comment(t, adam, tid, "Logged it.")
	self, _ := reply(t, adam, tid, adams.ID, "<p>Also in the CRM.</p>")
	wantMentions(t, adam, "Adam")
	if n := notified(w.agent.UserID, self.ID); n != 0 {
		t.Fatalf("self reply notified: %d", n)
	}
}
