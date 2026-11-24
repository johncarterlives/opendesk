package collab

import (
	"context"
	"testing"

	"github.com/useopendesk/opendesk/internal/auth"
)

// AI notes (contracts/collab.md "AI notes", GH#431): a collab:draft key leaves the team an
// internal comment, labelled with its name, that mentions no one and is never edited; a
// note can come with a new draft.
func TestAINotes(t *testing.T) {
	w, _, a, threads := queueWorld(t, 2)
	bot := w.api(w.key(w.agent, "Local drafter", auth.ScopeCollabDraft))
	human := w.api(w.agent)
	var e apiError

	var note MailComment
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
		map[string]any{"body_html": "<p>Complaint: a person decides on a credit.</p>"}, &note); st != 200 ||
		note.AINoteBy == nil || *note.AINoteBy != "Local drafter" || note.Author == nil || note.Author.ID != w.agent.UserID {
		t.Fatalf("AI note: %d %+v", st, note)
	}
	if n := w.count(`SELECT count(*) FROM audit_logs WHERE action = 'collab.ai_note_added' AND entity_id = $1
		AND data::text NOT LIKE '%credit%'`, note.ID); n != 1 {
		t.Fatalf("%d audit entries without the words", n)
	}

	// A mention would share the conversation: refused, by list or by mark.
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
		map[string]any{"body_html": "<p>Ask them</p>", "mentions": []string{w.agent2.UserID.String()}}, &e); st != 422 || e.Code != "ai_note_mentions" {
		t.Fatalf("mention by list: %d %+v", st, e)
	}
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
		map[string]any{"body_html": `<p><span data-type="mention" data-id="` + w.agent2.UserID.String() + `">@B</span></p>`}, &e); st != 422 {
		t.Fatalf("mention by mark: %d", st)
	}
	// A reply would notify the comment's author: refused. A person may reply to the note.
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
		map[string]any{"body_html": "<p>Agreed</p>", "reply_to": note.ID}, &e); st != 422 || e.Code != "ai_note_reply" {
		t.Fatalf("AI note as a reply: %d %+v", st, e)
	}
	var answer MailComment
	if st := doJSON(t, "POST", human.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
		map[string]any{"body_html": "<p>I'll decide.</p>", "reply_to": note.ID}, &answer); st != 200 ||
		answer.ReplyTo == nil || *answer.ReplyTo != note.ID || answer.AINoteBy != nil {
		t.Fatalf("reply to an AI note: %d %+v", st, answer)
	}

	// Never edited, by the key or the member it acts as; the member may delete it.
	if st := doJSON(t, "PATCH", bot.URL+"/v1/collab/comments/"+note.ID.String(), map[string]any{"body_html": "<p>x</p>"}, nil); st != 403 {
		t.Fatalf("key edits: %d", st)
	}
	if st := doJSON(t, "PATCH", human.URL+"/v1/collab/comments/"+note.ID.String(), map[string]any{"body_html": "<p>x</p>"}, nil); st != 403 {
		t.Fatalf("member edits an AI note: %d", st)
	}

	// A note with a new draft; a person's draft cannot carry one.
	m2 := w.messageByRemote(a, "m2")
	draft := map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m2.ID, "to": []string{"frank@example.com"}, "subject": "",
		"body_html": "<p>Yes, we can.</p>", "ai_note": "<p>Quantity above the quote: check the total.</p>"}
	if st := doJSON(t, "POST", human.URL+"/v1/collab/drafts", draft, &e); st != 422 {
		t.Fatalf("person's ai_note: %d", st)
	}
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/drafts", draft, nil); st != 200 {
		t.Fatalf("draft with a note: %d", st)
	}
	var d MailThreadDetail
	if st := doJSON(t, "GET", human.URL+"/v1/collab/threads/"+threads[1].String(), nil, &d); st != 200 || len(d.Comments) != 1 ||
		d.Comments[0].AINoteBy == nil || len(d.AISkips) != 0 {
		t.Fatalf("draft's note: %d %+v", st, d.Comments)
	}

	if st := doJSON(t, "DELETE", human.URL+"/v1/collab/comments/"+note.ID.String(), nil, nil); st != 204 {
		t.Fatalf("member deletes the AI note: %d", st)
	}
}

// A note that comes with a draft is stored in the draft's transaction, so both are kept or
// neither, and counts against the same 30-a-minute limit as the key's other notes.
func TestAINoteWithDraft(t *testing.T) {
	w, _, a, threads := queueWorld(t, 2)
	bot := w.api(w.key(w.agent, "Local drafter", auth.ScopeCollabDraft))
	m2 := w.messageByRemote(a, "m2")
	draft := func(note string) map[string]any {
		return map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m2.ID, "to": []string{"frank@example.com"}, "subject": "",
			"body_html": "<p>Yes, we can.</p>", "ai_note": note}
	}
	drafts := func() int {
		return w.count(`SELECT count(*) FROM collab_messages WHERE thread_id = $1 AND draft`, threads[1])
	}
	notes := func() int {
		return w.count(`SELECT count(*) FROM collab_comments WHERE thread_id = $1 AND ai_client IS NOT NULL`, threads[1])
	}

	// The note's write fails: the draft is not stored either.
	if _, err := w.d.DB.Pool.Exec(w.ctx, `ALTER TABLE collab_comments ADD CONSTRAINT test_refuse_note CHECK (body_html NOT LIKE '%refuse this note%')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = w.d.DB.Pool.Exec(context.Background(), `ALTER TABLE collab_comments DROP CONSTRAINT IF EXISTS test_refuse_note`)
	})
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/drafts", draft("<p>Please refuse this note.</p>"), nil); st != 500 {
		t.Fatalf("draft whose note fails: %d", st)
	}
	if d, n := drafts(), notes(); d != 0 || n != 0 {
		t.Fatalf("a failed note left %d drafts and %d notes", d, n)
	}
	if _, err := w.d.DB.Pool.Exec(w.ctx, `ALTER TABLE collab_comments DROP CONSTRAINT test_refuse_note`); err != nil {
		t.Fatal(err)
	}

	// The refused try, 28 notes on the conversation and one with a draft use the key's minute.
	for i := range 28 {
		if st := doJSON(t, "POST", bot.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
			map[string]any{"body_html": "<p>Note</p>"}, nil); st != 200 {
			t.Fatalf("note %d: %d", i, st)
		}
	}
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/drafts", draft("<p>Check the total.</p>"), nil); st != 200 {
		t.Fatalf("30th note, with a draft: %d", st)
	}
	if d, n := drafts(), notes(); d != 1 || n != 1 {
		t.Fatalf("draft with its note: %d drafts, %d notes", d, n)
	}
	// The 31st is refused before the draft is saved, whichever route it comes by.
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/drafts", draft("<p>And again.</p>"), nil); st != 429 {
		t.Fatalf("31st note, with a draft: %d", st)
	}
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/threads/"+threads[0].String()+"/comments",
		map[string]any{"body_html": "<p>Note</p>"}, nil); st != 429 {
		t.Fatalf("31st note: %d", st)
	}
	if d, n := drafts(), notes(); d != 1 || n != 1 {
		t.Fatalf("a refused note changed the drafts: %d drafts, %d notes", d, n)
	}
	// A draft without a note is not an AI note: the limit does not hold it back.
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/drafts", draft(""), nil); st != 200 {
		t.Fatalf("draft without a note: %d", st)
	}
}
