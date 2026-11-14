package tickets_test

import (
	"strings"
	"testing"
	"time"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// TestScheduledReply: a reply scheduled for later is checked now and sent then, as its
// author, stamped when it goes out; until then it can be moved, cancelled or sent now, and a
// send that is no longer allowed keeps the draft with the reason (contracts/api.md "Reply drafts").
func TestScheduledReply(t *testing.T) {
	e := hdtest.New(t, tickets.Register)
	ws := e.NewWorkspace()
	tk := createTicket(t, e, ws, map[string]any{"subject": "Later please", "contact": map[string]any{"email": "later@example.com", "name": "Lee"}})
	base := "/v1/tickets/" + tk.ID.String() + "/reply-draft"
	as := ws.Agent.As(ws)
	var got struct{ Draft *tickets.ReplyDraft }
	// Replies since this test began: creating the ticket already wrote the first one.
	count := func() int {
		return countRows(t, e, `SELECT count(*) FROM messages WHERE ticket_id = $1 AND kind = 'reply' AND author_user_id = $2`, tk.ID, ws.Agent.ID)
	}
	start := count()
	replies := func() int { return count() - start }
	reply := map[string]any{"kind": "reply", "body_html": "<p>Here is the update you asked for.</p>", "status": "pending"}

	at := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at.Add(789 * time.Nanosecond), "reply": reply}).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.Schedule == nil || !got.Draft.Schedule.SendAt.Equal(at) || got.Draft.Schedule.Status == nil ||
		*got.Draft.Schedule.Status != "pending" || !strings.Contains(got.Draft.BodyHTML, "the update") {
		t.Fatalf("scheduled: %+v", got.Draft)
	}
	if replies() != 0 || countRows(t, e, `SELECT count(*) FROM tickets WHERE id = $1 AND status = $2`, tk.ID, tk.Status) != 1 {
		var st string
		e.Scalar(`SELECT status FROM tickets WHERE id = $1`, &st, tk.ID)
		t.Fatalf("scheduling sent the reply or changed the ticket: replies %d, status %s (was %s)", replies(), st, tk.Status)
	}
	if countRows(t, e, `SELECT count(*) FROM river_job WHERE kind = 'helpdesk.scheduled_reply' AND args->>'ticket_id' = $1
		AND scheduled_at BETWEEN $2::timestamptz - interval '1 second' AND $2::timestamptz + interval '1 second'`, tk.ID.String(), at) != 1 {
		t.Fatal("no job at send_at")
	}
	// A delayed empty autosave cannot discard a scheduled reply.
	e.Do("DELETE", base, as, nil).Want(t, 204)
	e.Do("GET", base, as, nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.Schedule == nil {
		t.Fatal("a delayed discard removed a scheduled reply")
	}
	// A scheduled reply is not edited in place, and refusals come before anything is kept.
	e.Do("PUT", base, as, map[string]any{"body_html": "<p>changed</p>"}).Want(t, 409)
	for name, body := range map[string]map[string]any{
		"past":    {"send_at": time.Now().Add(-time.Minute), "reply": reply},
		"too far": {"send_at": time.Now().Add(400 * 24 * time.Hour), "reply": reply},
		"note":    {"send_at": at, "reply": map[string]any{"kind": "note", "body_html": "<p>x</p>"}},
		"address": {"send_at": at, "reply": map[string]any{"kind": "reply", "body_html": "<p>x</p>", "mailbox_id": "not-an-id"}},
	} {
		if r := e.Do("POST", base+"/schedule", as, body); r.Status < 400 {
			t.Fatalf("%s: %d", name, r.Status)
		}
	}
	e.Do("POST", base+"/schedule", ws.Viewer.As(ws), map[string]any{"send_at": at, "reply": reply}).Want(t, 403)

	// Moved to later: the job for the first time leaves it alone, the new one sends it.
	later := at.Add(time.Hour)
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": later}).Want(t, 200).JSON(t, &got)
	if !got.Draft.Schedule.SendAt.Equal(later) {
		t.Fatalf("moved: %+v", got.Draft.Schedule)
	}
	send := func(at time.Time) {
		t.Helper()
		if err := tickets.SendScheduledReply(e.Ctx, e.D, jobs.ScheduledReplyArgs{WorkspaceID: ws.ID, TicketID: tk.ID, UserID: ws.Agent.ID, SendAt: at}, false); err != nil {
			t.Fatal(err)
		}
	}
	send(at)
	if replies() != 0 {
		t.Fatal("sent at the old time")
	}
	before := time.Now()
	send(later)
	if replies() != 1 || countRows(t, e, `SELECT count(*) FROM tickets WHERE id = $1 AND status = 'pending'`, tk.ID) != 1 ||
		countRows(t, e, `SELECT count(*) FROM messages WHERE ticket_id = $1 AND author_user_id = $2 AND created_at >= $3`, tk.ID, ws.Agent.ID, before) != 1 {
		t.Fatal("not sent as scheduled, with its status, stamped when it went out")
	}
	e.Do("GET", base, as, nil).Want(t, 200).JSON(t, &got)
	if got.Draft != nil {
		t.Fatalf("draft after sending: %+v", got.Draft)
	}

	// Another reply sent meanwhile leaves a scheduled one in place.
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at, "reply": reply}).Want(t, 200)
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages", as, map[string]any{"kind": "reply", "body_html": "<p>A quick word first</p>"}).Want(t, 201)
	e.Do("GET", base, as, nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.Schedule == nil {
		t.Fatalf("another reply removed the scheduled one: %+v", got.Draft)
	}
	send(at)
	if replies() != 3 {
		t.Fatalf("replies %d after the scheduled one went out", replies())
	}

	// Cancelled: it stays a draft, and its job sends nothing.
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at, "reply": reply}).Want(t, 200)
	e.Do("DELETE", base+"/schedule", as, nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.Schedule != nil || !strings.Contains(got.Draft.BodyHTML, "the update") {
		t.Fatalf("cancelled: %+v", got.Draft)
	}
	send(at)
	if replies() != 3 {
		t.Fatal("a cancelled reply went out")
	}

	// Sent now instead.
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at, "reply": reply}).Want(t, 200)
	e.Do("POST", base+"/send", as, nil).Want(t, 201)
	if replies() != 4 {
		t.Fatal("send now did not send")
	}
	e.Do("POST", base+"/send", as, nil).Want(t, 404)

	// A scheduled reply outlives the purge of drafts left alone for a month.
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at, "reply": reply}).Want(t, 200)
	e.Exec(`UPDATE ticket_reply_drafts SET updated_at = now() - interval '40 days' WHERE ticket_id = $1`, tk.ID)
	if err := tickets.PurgeAttachments(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
	if countRows(t, e, `SELECT count(*) FROM ticket_reply_drafts WHERE ticket_id = $1`, tk.ID) != 1 {
		t.Fatal("a scheduled reply was purged as a stale draft")
	}

	// Its author may no longer reply when it is due: it stays their draft, with why.
	e.Exec(`UPDATE members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2`, ws.ID, ws.Agent.ID)
	send(at)
	e.Exec(`UPDATE members SET role = 'agent' WHERE workspace_id = $1 AND user_id = $2`, ws.ID, ws.Agent.ID)
	e.Do("GET", base, as, nil).Want(t, 200).JSON(t, &got)
	if replies() != 4 || got.Draft == nil || got.Draft.Schedule != nil || got.Draft.SendError != tickets.SendErrorMemberGone {
		t.Fatalf("kept after a refused send: %+v", got.Draft)
	}
	// They are told, and their reply box follows live.
	if countRows(t, e, `SELECT count(*) FROM notifications WHERE user_id = $1 AND ticket_id = $2 AND type = 'scheduled_reply_failed'
		AND data->>'reason' = 'member_gone'`, ws.Agent.ID, tk.ID) != 1 {
		t.Fatal("no scheduled_reply_failed notification")
	}
	if countRows(t, e, `SELECT count(*) FROM events WHERE workspace_id = $1 AND type = 'reply_draft.updated' AND user_ids = ARRAY[$2]::uuid[]`, ws.ID, ws.Agent.ID) == 0 {
		t.Fatal("no reply_draft.updated to its author alone")
	}
}

// TestScheduledReplyMerged: a reply scheduled on a ticket merged since never goes out from the
// closed source ticket: the merge keeps it as its author's draft, and sending or scheduling on
// the merged ticket is refused.
func TestScheduledReplyMerged(t *testing.T) {
	e := hdtest.New(t, tickets.Register)
	ws := e.NewWorkspace()
	src := createTicket(t, e, ws, map[string]any{"subject": "First", "contact": map[string]any{"email": "merge@example.com", "name": "Mo"}})
	dst := createTicket(t, e, ws, map[string]any{"subject": "Second", "contact": map[string]any{"email": "merge@example.com", "name": "Mo"}})
	base := "/v1/tickets/" + src.ID.String() + "/reply-draft"
	as := ws.Agent.As(ws)
	reply := map[string]any{"kind": "reply", "body_html": "<p>Following up.</p>"}
	at := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	count := func() int {
		return countRows(t, e, `SELECT count(*) FROM messages WHERE kind = 'reply' AND author_user_id = $1 AND body_text LIKE 'Following up%'`, ws.Agent.ID)
	}

	// An admin merges it: the agent's scheduled reply stays their draft, and they are told.
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at, "reply": reply}).Want(t, 200)
	e.Do("POST", "/v1/tickets/"+src.ID.String()+"/merge", ws.Admin.As(ws), map[string]any{"into_id": dst.ID.String()}).Want(t, 200)
	var got struct{ Draft *tickets.ReplyDraft }
	e.Do("GET", base, as, nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.Schedule != nil || got.Draft.SendError != tickets.SendErrorMerged {
		t.Fatalf("after the merge: %+v", got.Draft)
	}
	if countRows(t, e, `SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'scheduled_reply_failed' AND data->>'reason' = 'merged'`, ws.Agent.ID) != 1 {
		t.Fatal("the author was not told the merge stopped their reply")
	}
	if err := tickets.SendScheduledReply(e.Ctx, e.D, jobs.ScheduledReplyArgs{WorkspaceID: ws.ID, TicketID: src.ID, UserID: ws.Agent.ID, SendAt: at}, false); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("a reply scheduled on a merged ticket went out")
	}
	// Nor can it be scheduled or sent there again.
	e.Do("POST", base+"/schedule", as, map[string]any{"send_at": at, "reply": reply}).Want(t, 409)

	// A job that finds the ticket merged (the draft still scheduled) keeps it with the reason.
	e.Exec(`UPDATE ticket_reply_drafts SET send_at = $2, send_request = '{"kind":"reply"}', send_error = '' WHERE ticket_id = $1`, src.ID, at)
	e.Do("POST", base+"/send", as, nil).Want(t, 409)
	if err := tickets.SendScheduledReply(e.Ctx, e.D, jobs.ScheduledReplyArgs{WorkspaceID: ws.ID, TicketID: src.ID, UserID: ws.Agent.ID, SendAt: at}, false); err != nil {
		t.Fatal(err)
	}
	e.Do("GET", base, as, nil).Want(t, 200).JSON(t, &got)
	if count() != 0 || got.Draft == nil || got.Draft.Schedule != nil || got.Draft.SendError != tickets.SendErrorMerged {
		t.Fatalf("job on a merged ticket: sent %d, draft %+v", count(), got.Draft)
	}
}
