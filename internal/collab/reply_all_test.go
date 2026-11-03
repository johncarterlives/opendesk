package collab

import (
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
)

func TestAPIConversationReplyAllDefault(t *testing.T) {
	for _, visibility := range []string{VisibilityPrivate, VisibilityShared} {
		for _, access := range []string{"person", "team", "assigned"} {
			t.Run(visibility+"/"+access, func(t *testing.T) {
				w := newWorld(t)
				a := w.account(w.agent, ProviderGoogle, visibility, Audience{UserIDs: []uuid.UUID{w.owner.UserID}})
				tid, mid := w.seedThread(a, "Help with this conversation", w.folder(a, RoleInbox))
				mustExec(t, w.d, `UPDATE collab_messages SET cc_addrs = '[{"email":"other@example.com"}]' WHERE id=$1`, mid)
				owner, recipient := w.api(w.agent), w.api(w.agent2)
				path := "/v1/collab/threads/" + tid.String()
				sharePath := path + "/shares"
				var body any = map[string]any{"shares": Audience{UserIDs: []uuid.UUID{w.agent2.UserID}}}
				switch access {
				case "team":
					body = map[string]any{"shares": Audience{TeamIDs: []uuid.UUID{w.team("Helpers", w.agent2)}}}
				case "assigned":
					sharePath, body = path+"/assignees", map[string]any{"user_ids": []uuid.UUID{w.agent2.UserID}}
				}
				if st := doJSON(t, "PUT", owner.URL+sharePath, body, nil); st != 200 {
					t.Fatalf("grant conversation access: %d", st)
				}
				var accounts []MailAccount
				if st := doJSON(t, "GET", recipient.URL+"/v1/collab/accounts", nil, &accounts); st != 200 || len(accounts) != 0 {
					t.Fatalf("conversation-only account list: %d %+v", st, accounts)
				}
				var detail MailThreadDetail
				if st := doJSON(t, "GET", recipient.URL+path, nil, &detail); st != 200 || !detail.CanAct || detail.Account.ReplyAll {
					t.Fatalf("initial reply default: %d %+v", st, detail)
				}
				for _, enabled := range []bool{true, false} {
					if st := doJSON(t, "PATCH", owner.URL+"/v1/collab/accounts/"+a.ID.String(), map[string]any{"reply_all": enabled}, nil); st != 200 {
						t.Fatalf("set reply default: %d", st)
					}
					if st := doJSON(t, "GET", recipient.URL+path, nil, &detail); st != 200 || !detail.CanAct || detail.Account.ReplyAll != enabled || len(detail.Messages) != 1 || len(detail.Messages[0].Cc) != 1 {
						t.Fatalf("conversation reply default %t: %d %+v", enabled, st, detail)
					}
				}
				if st := doJSON(t, "PATCH", recipient.URL+"/v1/collab/accounts/"+a.ID.String(), map[string]any{"reply_all": true}, nil); st != 404 {
					t.Fatalf("conversation-only recipient manages account: %d", st)
				}
			})
		}
	}
}

func TestAPIReplyAllInvalidationRespectsConversationAudience(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	shared, _ := w.seedThread(a, "Shared", w.folder(a, RoleInbox))
	assigned, _ := w.seedThread(a, "Assigned", w.folder(a, RoleInbox))
	private, _ := w.seedThread(a, "Private", w.folder(a, RoleInbox))
	owner := w.api(w.agent)
	if st := doJSON(t, "PUT", owner.URL+"/v1/collab/threads/"+shared.String()+"/shares", map[string]any{"shares": Audience{UserIDs: []uuid.UUID{w.agent2.UserID}}}, nil); st != 200 {
		t.Fatalf("share: %d", st)
	}
	if st := doJSON(t, "PUT", owner.URL+"/v1/collab/threads/"+assigned.String()+"/assignees", map[string]any{"user_ids": []uuid.UUID{w.owner.UserID}}, nil); st != 200 {
		t.Fatalf("assign: %d", st)
	}
	for step, enabled := range []bool{true, true, false} {
		seq := w.count(`SELECT event_seq FROM workspaces WHERE id=$1`, w.wid)
		if st := doJSON(t, "PATCH", owner.URL+"/v1/collab/accounts/"+a.ID.String(), map[string]any{"reply_all": enabled}, nil); st != 200 {
			t.Fatalf("set preference: %d", st)
		}
		want := 2
		if step == 1 {
			want = 0
		}
		if n := w.count(`SELECT count(*) FROM events WHERE workspace_id=$1 AND seq>$2 AND type='collab.changed'`, w.wid, seq); n != want {
			t.Fatalf("conversation refresh events = %d, want %d", n, want)
		}
		for _, c := range []struct{ user, thread, hidden uuid.UUID }{
			{w.agent2.UserID, shared, assigned}, {w.owner.UserID, assigned, shared},
		} {
			wantOwn := want / 2
			if n := w.count(`SELECT count(*) FROM events WHERE workspace_id=$1 AND seq>$2 AND type='collab.changed'
				AND $3=ANY(user_ids) AND data->'thread_ids'=$4::jsonb AND data->>'account_id'=$5 AND data->>'folders'='false'`,
				w.wid, seq, c.user, fmt.Sprintf(`["%s"]`, c.thread), a.ID.String()); n != wantOwn {
				t.Fatalf("recipient refresh = %d, want %d", n, wantOwn)
			}
			if n := w.count(`SELECT count(*) FROM events WHERE workspace_id=$1 AND seq>$2 AND $3=ANY(user_ids)
				AND (type='collab.accounts' OR data->'thread_ids' ? $4 OR data->'thread_ids' ? $5)`, w.wid, seq, c.user, c.hidden.String(), private.String()); n != 0 {
				t.Fatalf("recipient received unrelated private account/conversation event: %d", n)
			}
		}
		if n := w.count(`SELECT count(*) FROM events WHERE workspace_id=$1 AND seq>$2 AND $3=ANY(user_ids)`, w.wid, seq, w.viewer.UserID); n != 0 {
			t.Fatalf("unrelated viewer received private events: %d", n)
		}
	}
	for _, p := range []*auth.Principal{w.agent2, w.owner, w.viewer} {
		srv := w.api(p)
		var accounts []MailAccount
		if st := doJSON(t, "GET", srv.URL+"/v1/collab/accounts", nil, &accounts); st != 200 || len(accounts) != 0 {
			t.Fatalf("private account visible: %d %+v", st, accounts)
		}
		if st := doJSON(t, "GET", srv.URL+"/v1/collab/threads/"+private.String(), nil, nil); st != 404 {
			t.Fatalf("unshared mail visible: %d", st)
		}
	}
}
