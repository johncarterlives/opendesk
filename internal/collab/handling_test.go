package collab

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/ids"
)

// TestHandlingState covers contracts/collab.md "Handling": opt-in per account, new
// inbound mail needs action whatever its read state, a reply or "done" clears it, a
// later inbound message sets it again, and mail from before the switch never needs it.
func TestHandlingState(t *testing.T) {
	w := newWorld(t)
	w.useFake(&fakeProvider{})
	a := w.account(w.agent, ProviderIMAP, VisibilityPrivate, Audience{})
	inbox := w.folder(a, RoleInbox)
	srv := w.api(w.agent)
	base := "/v1/collab/threads"

	recompute := func(tid uuid.UUID) {
		t.Helper()
		if err := w.d.DB.Tx(w.ctx, func(tx pgx.Tx) error { return recomputeThreads(w.ctx, tx, a, []uuid.UUID{tid}) }); err != nil {
			t.Fatal(err)
		}
	}
	// addMessage stores one more message in the conversation, from the account or not.
	addMessage := func(tid uuid.UUID, own bool, at time.Time) {
		t.Helper()
		mid := ids.New()
		from, to := Address{Email: "from@example.com"}, []Address{{Email: a.Email}}
		if own {
			from, to = Address{Email: a.Email}, []Address{{Email: "from@example.com"}}
		}
		mustExec(t, w.d, `INSERT INTO collab_messages (id, workspace_id, account_id, thread_id, remote_id, message_id, from_addr, to_addrs,
			subject, snippet, body_html, body_text, sent_at, unread) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Re', 'x', '<p>x</p>', 'x', $9, $10)`,
			mid, w.wid, a.ID, tid, "m-"+mid.String(), mid.String()+"@example.com", from, to, at, !own)
		mustExec(t, w.d, `INSERT INTO collab_message_folders (message_id, folder_id) VALUES ($1, $2)`, mid, inbox.ID)
		recompute(tid)
	}
	state := func(tid uuid.UUID) string {
		t.Helper()
		var out struct {
			Thread MailThread `json:"thread"`
		}
		if st := doJSON(t, "GET", srv.URL+base+"/"+tid.String(), nil, &out); st != 200 {
			t.Fatalf("thread: %d", st)
		}
		if out.Thread.Handling == nil {
			return ""
		}
		return *out.Thread.Handling
	}
	counts := func() (int, int) {
		t.Helper()
		var c CollabCounts
		if st := doJSON(t, "GET", srv.URL+"/v1/collab/counts", nil, &c); st != 200 {
			t.Fatalf("counts: %d", st)
		}
		return c.Boxes.NeedsAction, c.NeedsAction[a.ID]
	}
	mark := func(tid uuid.UUID, h string) int {
		t.Helper()
		return doJSON(t, "POST", srv.URL+base+"/handling", map[string]any{"thread_ids": []uuid.UUID{tid}, "handling": h}, nil)
	}
	toggle := func(on bool) {
		t.Helper()
		var out struct {
			Handling bool `json:"handling"`
		}
		if st := doJSON(t, "PATCH", srv.URL+"/v1/collab/accounts/"+a.ID.String(), map[string]any{"handling": on}, &out); st != 200 || out.Handling != on {
			t.Fatalf("toggle %v: %d %+v", on, st, out)
		}
	}

	// Off: no handling state, and it cannot be set.
	before, _ := w.seedThread(a, "Before", inbox)
	recompute(before)
	if s := state(before); s != "" {
		t.Fatalf("off: %q", s)
	}
	if st := mark(before, HandlingDone); st != 422 {
		t.Fatalf("mark while off: %d", st)
	}

	toggle(true)
	// Mail from before the switch does not need action.
	if s := state(before); s != HandlingDone {
		t.Fatalf("history: %q", s)
	}

	soon := time.Now().Add(time.Minute)
	tid, _ := w.seedThread(a, "Help", inbox)
	mustExec(t, w.d, `UPDATE collab_messages SET sent_at = $2 WHERE thread_id = $1`, tid, soon)
	recompute(tid)
	if s := state(tid); s != HandlingNeedsAction {
		t.Fatalf("new inbound: %q", s)
	}
	if all, mine := counts(); all != 1 || mine != 1 {
		t.Fatalf("counts: %d %d", all, mine)
	}
	var list struct {
		Data []MailThread `json:"data"`
	}
	if st := doJSON(t, "GET", srv.URL+base+"?box=needs_action", nil, &list); st != 200 || len(list.Data) != 1 || list.Data[0].ID != tid {
		t.Fatalf("box: %d %+v", st, list.Data)
	}

	// Reading it does not change it.
	mustExec(t, w.d, `UPDATE collab_messages SET unread = false WHERE thread_id = $1`, tid)
	recompute(tid)
	if s := state(tid); s != HandlingNeedsAction {
		t.Fatalf("after read: %q", s)
	}

	// People mark it done and back.
	if st := mark(tid, HandlingDone); st != 200 || state(tid) != HandlingDone {
		t.Fatalf("done: %d", st)
	}
	if all, _ := counts(); all != 0 {
		t.Fatalf("count after done: %d", all)
	}
	if st := mark(tid, HandlingNeedsAction); st != 200 || state(tid) != HandlingNeedsAction {
		t.Fatalf("needs action: %d", st)
	}

	// A reply from the account clears it; a later inbound message sets it again.
	addMessage(tid, true, soon.Add(time.Minute))
	if s := state(tid); s != HandlingDone {
		t.Fatalf("after reply: %q", s)
	}
	addMessage(tid, false, soon.Add(2*time.Minute))
	if s := state(tid); s != HandlingNeedsAction {
		t.Fatalf("after new inbound: %q", s)
	}

	// Off again: nothing needs action, and it is left out of the thread.
	toggle(false)
	if s := state(tid); s != "" {
		t.Fatalf("off again: %q", s)
	}
	if all, _ := counts(); all != 0 {
		t.Fatalf("count off: %d", all)
	}
}
