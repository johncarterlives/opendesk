package collab

import (
	"fmt"
	"net/http/httptest"
	"net/url"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/httpx"
)

// The Mentions box (contracts/collab.md "Mentions").

// mentionsOf lists srv's Mentions box, one page of limit (0: the default) after cursor.
func mentionsOf(t *testing.T, srv *httptest.Server, limit int, cursor string) httpx.Page[MailThread] {
	t.Helper()
	q := url.Values{"box": {BoxMentions}}
	if limit > 0 {
		q.Set("limit", fmt.Sprint(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var page httpx.Page[MailThread]
	if st := doJSON(t, "GET", srv.URL+"/v1/collab/threads?"+q.Encode(), nil, &page); st != 200 {
		t.Fatalf("mentions: %d", st)
	}
	return page
}

func mentionCount(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	var c CollabCounts
	if st := doJSON(t, "GET", srv.URL+"/v1/collab/counts", nil, &c); st != 200 {
		t.Fatalf("counts: %d", st)
	}
	return c.Boxes.Mentions
}

func comment(t *testing.T, srv *httptest.Server, tid uuid.UUID, text string, mentions ...uuid.UUID) MailComment {
	t.Helper()
	if mentions == nil {
		mentions = []uuid.UUID{}
	}
	var c MailComment
	if st := doJSON(t, "POST", srv.URL+"/v1/collab/threads/"+tid.String()+"/comments", map[string]any{"body_html": "<p>" + text + "</p>", "mentions": mentions}, &c); st != 200 {
		t.Fatalf("comment %q: %d", text, st)
	}
	return c
}

// wantMentions checks a member's Mentions box, in order, and its count.
func wantMentions(t *testing.T, srv *httptest.Server, who string, want ...uuid.UUID) {
	t.Helper()
	got := []uuid.UUID{}
	for _, th := range mentionsOf(t, srv, 0, "").Data {
		got = append(got, th.ID)
	}
	if want == nil {
		want = []uuid.UUID{}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("%s's Mentions = %v, want %v", who, got, want)
	}
	if n := mentionCount(t, srv); n != len(want) {
		t.Fatalf("%s's mentions count = %d, want %d", who, n, len(want))
	}
}

func followingOf(t *testing.T, srv *httptest.Server, tid uuid.UUID) bool {
	t.Helper()
	var d MailThreadDetail
	if st := doJSON(t, "GET", srv.URL+"/v1/collab/threads/"+tid.String(), nil, &d); st != 200 {
		t.Fatalf("detail: %d", st)
	}
	return d.Following
}

var everyone = Audience{Everyone: true, TeamIDs: []uuid.UUID{}, UserIDs: []uuid.UUID{}}

func TestAPIMentionsFollowAndUnfollow(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityShared, everyone)
	tid, _ := w.seedThread(a, "Refund question", w.folder(a, RoleInbox))
	adam, bea, olive, vic := w.api(w.agent), w.api(w.agent2), w.api(w.owner), w.api(w.viewer)
	follow := "/v1/collab/threads/" + tid.String() + "/follow"
	unfollow := func(srv *httptest.Server) {
		t.Helper()
		if st := doJSON(t, "DELETE", srv.URL+follow, nil, nil); st != 204 {
			t.Fatalf("unfollow: %d", st)
		}
	}

	wantMentions(t, bea, "Bea")

	// A mention follows; the author does not follow their own comment.
	comment(t, adam, tid, "Bea, can you take this?", w.agent2.UserID)
	wantMentions(t, bea, "Bea", tid)
	wantMentions(t, adam, "Adam")
	if !followingOf(t, bea, tid) || followingOf(t, adam, tid) {
		t.Fatal("following: Bea should, Adam should not")
	}

	// Removing herself takes it off her Mentions only: she still sees it. Doing it twice is fine.
	unfollow(bea)
	unfollow(bea)
	wantMentions(t, bea, "Bea")
	if followingOf(t, bea, tid) {
		t.Fatal("still following after unfollow")
	}

	// Mentioned again, she is back.
	comment(t, adam, tid, "Bea, one more thing", w.agent2.UserID)
	wantMentions(t, bea, "Bea", tid)

	// A reply to her comment brings her back too.
	unfollow(bea)
	comment(t, bea, tid, "Done, refunded.")
	wantMentions(t, bea, "Bea")
	// Her comment answered Adam's: he follows it now.
	wantMentions(t, adam, "Adam", tid)
	comment(t, adam, tid, "Thanks!")
	wantMentions(t, bea, "Bea", tid)
	// The same person writing on is still answering her.
	unfollow(bea)
	comment(t, adam, tid, "And they wrote back happy.")
	wantMentions(t, bea, "Bea", tid)

	// Someone else chiming in after that answer is not a reply to her.
	unfollow(bea)
	comment(t, olive, tid, "Nice work, both.")
	wantMentions(t, bea, "Bea")

	// An edit that adds a mention follows the person added.
	c := comment(t, olive, tid, "Noted.")
	if st := doJSON(t, "PATCH", olive.URL+"/v1/collab/comments/"+c.ID.String(), map[string]any{
		"body_html": fmt.Sprintf(`<p>Noted, <span data-type="mention" data-id="%s">@Bea</span>.</p>`, w.agent2.UserID)}, nil); st != 200 {
		t.Fatalf("edit: %d", st)
	}
	wantMentions(t, bea, "Bea", tid)

	// Following by hand; a viewer, who can be mentioned, removes themselves.
	if st := doJSON(t, "PUT", olive.URL+follow, nil, nil); st != 204 {
		t.Fatalf("follow by hand: %d", st)
	}
	wantMentions(t, olive, "Olive", tid)
	comment(t, adam, tid, "Vic, for the record.", w.viewer.UserID)
	wantMentions(t, vic, "Vic", tid)
	unfollow(vic)
	wantMentions(t, vic, "Vic")
	// Nobody else's follow moved.
	wantMentions(t, bea, "Bea", tid)
	wantMentions(t, olive, "Olive", tid)

	// Trash leaves the box, as it leaves Shared with me and Assigned to me.
	if st := doJSON(t, "POST", adam.URL+"/v1/collab/threads/actions", map[string]any{"thread_ids": []uuid.UUID{tid}, "action": "trash"}, nil); st != 200 {
		t.Fatalf("trash: %d", st)
	}
	wantMentions(t, bea, "Bea")
}

func TestAPIMentionsOnlyWhatTheMemberSees(t *testing.T) {
	w := newWorld(t)
	// Adam's private account: Bea sees one conversation only once he mentions her.
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	tid, _ := w.seedThread(a, "Private but tricky", w.folder(a, RoleInbox))
	adam, bea, olive := w.api(w.agent), w.api(w.agent2), w.api(w.owner)
	follow := "/v1/collab/threads/" + tid.String() + "/follow"

	// Nobody follows what they cannot see, an admin included.
	for _, srv := range []*httptest.Server{bea, olive} {
		if st := doJSON(t, "PUT", srv.URL+follow, nil, nil); st != 404 {
			t.Fatalf("follow unseen: %d, want 404", st)
		}
	}
	wantMentions(t, olive, "Olive")

	comment(t, adam, tid, "Bea, a second pair of eyes?", w.agent2.UserID)
	wantMentions(t, bea, "Bea", tid)
	wantMentions(t, olive, "Olive")

	// Bea answers; then Adam unshares it. It leaves her box though the follow is kept, and she
	// can no longer change it.
	comment(t, bea, tid, "Looks like a refund to me.")
	if st := doJSON(t, "PUT", adam.URL+"/v1/collab/threads/"+tid.String()+"/shares", map[string]any{"shares": Audience{TeamIDs: []uuid.UUID{}, UserIDs: []uuid.UUID{}}}, nil); st != 200 {
		t.Fatalf("unshare: %d", st)
	}
	wantMentions(t, bea, "Bea")
	if st := doJSON(t, "DELETE", bea.URL+follow, nil, nil); st != 404 {
		t.Fatalf("unfollow unseen: %d, want 404", st)
	}
	// Answering someone who no longer sees it, or mentioning someone, never shows it to them
	// through the box without a share: a mention shares it again, an answer does not.
	mustExec(t, w.d, `DELETE FROM collab_thread_followers WHERE thread_id = $1`, tid)
	comment(t, adam, tid, "Thanks, refunding.")
	if n := w.count(`SELECT count(*) FROM collab_thread_followers WHERE thread_id = $1 AND user_id = $2`, tid, w.agent2.UserID); n != 0 {
		t.Fatalf("an answer followed someone who cannot see it: %d", n)
	}
	wantMentions(t, bea, "Bea")
}

func TestAPIMentionsOrderAndPages(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityShared, everyone)
	older, _ := w.seedThread(a, "Older mail", w.folder(a, RoleInbox))
	newer, _ := w.seedThread(a, "Newer mail", w.folder(a, RoleInbox))
	mustExec(t, w.d, `UPDATE collab_threads SET last_message_at = now() - interval '2 days' WHERE id = $1`, older)
	mustExec(t, w.d, `UPDATE collab_threads SET last_message_at = now() - interval '1 day' WHERE id = $1`, newer)
	adam, bea := w.api(w.agent), w.api(w.agent2)

	comment(t, adam, newer, "Bea?", w.agent2.UserID)
	comment(t, adam, older, "Bea, this one first", w.agent2.UserID)
	// Newest activity first: the latest mention outranks newer mail.
	wantMentions(t, bea, "Bea", older, newer)

	first := mentionsOf(t, bea, 1, "")
	if len(first.Data) != 1 || first.Data[0].ID != older || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	second := mentionsOf(t, bea, 1, *first.NextCursor)
	if len(second.Data) != 1 || second.Data[0].ID != newer || second.NextCursor != nil {
		t.Fatalf("second page: %+v", second)
	}

	// A comment in a followed conversation is activity for its followers.
	comment(t, adam, newer, "An update for whoever follows this")
	wantMentions(t, bea, "Bea", newer, older)
}
