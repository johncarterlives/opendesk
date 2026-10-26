package collab

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
)

// The AI queue (contracts/collab.md "AI queue"): keys claim the conversation that has
// waited longest in Needs action on a shared account with handling on, one holder at a
// time; a claim expires on its own; a draft ends it and keeps the conversation in Needs
// action for a person; a skip holds until new mail arrives. People, viewers' keys and keys
// without the scope get nothing.

type claimResp struct {
	Claim        *AIClaim          `json:"claim"`
	Conversation *MailThreadDetail `json:"conversation"`
}

func TestAIQueue(t *testing.T) {
	w := newWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityShared, Audience{Everyone: true})
	mustExec(t, w.d, `UPDATE collab_accounts SET handling_enabled = true WHERE id = $1`, a.ID)
	now := time.Now()
	g.add("m1", "t1", []string{"INBOX", "UNREAD"}, testMail{from: "frank@example.com", to: a.Email, subject: "Oldest", msgID: "q1@example.com",
		body: "First", date: now.Add(-3 * time.Hour)})
	g.add("m2", "t2", []string{"INBOX", "UNREAD"}, testMail{from: "gina@example.com", to: a.Email, subject: "Middle", msgID: "q2@example.com",
		body: "Second", date: now.Add(-2 * time.Hour)})
	g.add("m3", "t3", []string{"INBOX", "UNREAD"}, testMail{from: "hal@example.com", to: a.Email, subject: "Newest", msgID: "q3@example.com",
		body: "Third", date: now.Add(-time.Hour)})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	t1, t2, t3 := w.messageByRemote(a, "m1").ThreadID, w.messageByRemote(a, "m2").ThreadID, w.messageByRemote(a, "m3").ThreadID
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE account_id = $1 AND needs_action`, a.ID); n != 3 {
		t.Fatalf("%d conversations need action", n)
	}
	botKey := w.key(w.agent, "Local drafter", auth.ScopeCollabDraft)
	bot, bot2 := w.api(botKey), w.api(w.key(w.agent2, "Second drafter", auth.ScopeCollabDraft))
	claim := func(srv string, want uuid.UUID) {
		t.Helper()
		var r claimResp
		st := doJSON(t, "POST", srv+"/v1/collab/ai-queue/claim", map[string]any{}, &r)
		if st != 200 {
			t.Fatalf("claim: %d", st)
		}
		got := uuid.Nil
		if r.Claim != nil {
			got = r.Claim.ConversationID
			if r.Conversation == nil || r.Conversation.Thread.ID != got || len(r.Conversation.Messages) == 0 {
				t.Fatalf("claim without its conversation: %+v", r)
			}
			if d := time.Until(r.Claim.ExpiresAt); d < 4*time.Minute || d > 6*time.Minute {
				t.Fatalf("claim expires in %s", d)
			}
		}
		if got != want {
			t.Fatalf("claimed %s, want %s", got, want)
		}
	}
	release := func(srv string, id uuid.UUID, body any) int {
		t.Helper()
		return doJSON(t, "POST", srv+"/v1/collab/ai-queue/claims/"+id.String()+"/release", body, nil)
	}

	// Oldest first, one holder each.
	claim(bot.URL, t1)
	claim(bot2.URL, t2)
	claim(bot.URL, t3)
	claim(bot2.URL, uuid.Nil)

	// Only the holder releases its claim.
	if st := release(bot2.URL, t1, nil); st != 404 {
		t.Fatalf("another key's claim: %d", st)
	}
	// A skip holds for that key until new mail; a plain release offers it again.
	if st := release(bot2.URL, t2, map[string]any{"skip": true, "reason": "not confident"}); st != 204 {
		t.Fatalf("skip: %d", st)
	}
	if n := w.count(`SELECT count(*) FROM collab_ai_skips WHERE thread_id = $1 AND reason = 'not confident'`, t2); n != 1 {
		t.Fatal("skip not kept")
	}
	claim(bot2.URL, uuid.Nil)
	if st := release(bot.URL, t3, map[string]any{}); st != 204 {
		t.Fatalf("release: %d", st)
	}
	claim(bot2.URL, t3)
	claim(bot.URL, t2) // skipped by the other key only

	// A draft is the report back: the claim ends, the conversation still needs action for a
	// person, and it is not offered again while the draft waits.
	m2 := w.messageByRemote(a, "m2")
	var d MailMessage
	if st := doJSON(t, "POST", bot.URL+"/v1/collab/drafts", map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m2.ID,
		"to": []string{"gina@example.com"}, "subject": "", "body_html": "<p>Yes.</p>"}, &d); st != 200 || d.DraftedByAI == nil {
		t.Fatalf("draft: %d %+v", st, d)
	}
	if n := w.count(`SELECT count(*) FROM collab_ai_claims WHERE thread_id = $1`, t2); n != 0 {
		t.Fatal("the draft did not end the claim")
	}
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE id = $1 AND needs_action`, t2); n != 1 {
		t.Fatal("an AI draft cleared Needs action")
	}

	// An expired claim is taken over.
	mustExec(t, w.d, `UPDATE collab_ai_claims SET expires_at = now() - interval '1 second' WHERE thread_id = $1`, t3)
	claim(bot.URL, t3)
	if st := release(bot2.URL, t3, nil); st != 404 {
		t.Fatalf("expired claim released: %d", st)
	}

	// New mail lifts a skip.
	if st := release(bot.URL, t1, map[string]any{"skip": true}); st != 204 {
		t.Fatalf("skip t1: %d", st)
	}
	if st := release(bot.URL, t3, nil); st != 204 {
		t.Fatalf("release t3: %d", st)
	}
	claim(bot.URL, t3)
	claim(bot.URL, uuid.Nil)
	g.add("m4", "t1", []string{"INBOX", "UNREAD"}, testMail{from: "frank@example.com", to: a.Email, subject: "Re: Oldest", msgID: "q4@example.com",
		inReplyTo: "q1@example.com", refs: "<q1@example.com>", body: "Any news?", date: now.Add(-time.Minute)})
	g.record("messagesAdded", "m4")
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if w.messageByRemote(a, "m4").ThreadID != t1 {
		t.Fatal("the new mail is not in t1")
	}
	claim(bot.URL, t1)

	// Claims of a revoked key do not hold their conversations (t3 has waited longest).
	mustExec(t, w.d, `UPDATE api_keys SET revoked_at = now() WHERE id = $1`, botKey.APIKeyID)
	claim(bot2.URL, t3)
	claim(bot2.URL, t1)

	// Handling off: nothing is offered.
	for _, id := range []uuid.UUID{t1, t3} {
		if st := release(bot2.URL, id, nil); st != 204 {
			t.Fatalf("release: %d", st)
		}
	}
	mustExec(t, w.d, `UPDATE collab_accounts SET handling_enabled = false WHERE id = $1`, a.ID)
	claim(bot2.URL, uuid.Nil)
	mustExec(t, w.d, `UPDATE collab_accounts SET handling_enabled = true WHERE id = $1`, a.ID)

	// People, a viewer's key and a key without the scope do not use the queue.
	for name, p := range map[string]*auth.Principal{
		"person":     w.agent,
		"viewer key": w.key(w.viewer, "Vic's key", auth.ScopeCollabDraft),
		"no scope":   w.key(w.agent, "Tickets key", auth.ScopeTicketsRead),
	} {
		if st := doJSON(t, "POST", w.api(p).URL+"/v1/collab/ai-queue/claim", map[string]any{}, nil); st != 403 {
			t.Fatalf("%s: %d", name, st)
		}
	}
}
