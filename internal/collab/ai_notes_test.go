package collab

import (
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
