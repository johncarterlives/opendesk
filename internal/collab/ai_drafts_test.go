package collab

import (
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/ids"
)

// AI drafts (contracts/collab.md "AI drafts"): a client connected through a member's OAuth
// grant with collab:draft reads what the member sees and saves reply drafts labelled as
// its own; it never sends, changes read state, touches a person's draft or reaches mail
// the member does not see. API keys, grants without the scope and the assistant stay out.

// grant connects an AI client named name for p with scopes and returns its principal.
func (w *world) grant(p *auth.Principal, name string, scopes ...string) *auth.Principal {
	w.t.Helper()
	cid, gid := ids.New(), ids.New()
	mustExec(w.t, w.d, `INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, '{https://client.test/cb}')`, cid, name)
	mustExec(w.t, w.d, `INSERT INTO oauth_grants (id, workspace_id, user_id, client_id, scopes, resource) VALUES ($1, $2, $3, $4, $5, 'http://api.test/mcp')`,
		gid, w.wid, p.UserID, cid, scopes)
	return &auth.Principal{Kind: auth.KindUser, UserID: p.UserID, WorkspaceID: w.wid, Role: p.Role, GrantID: gid, Scopes: scopes, IP: "127.0.0.1"}
}

func TestAIClientDrafts(t *testing.T) {
	w := newWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	g.add("m1", "t1", []string{"INBOX", "UNREAD"}, testMail{from: "Frank <frank@example.com>", to: a.Email, subject: "Quote?", msgID: "h1@example.com", body: "Price for 500?"})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	m1 := w.messageByRemote(a, "m1")
	bot := w.grant(w.agent, "Local drafter", auth.ScopeCollabDraft)
	ai := w.api(bot)
	var e apiError

	// It lists and reads what the member sees, and reading leaves the conversation unread.
	var list struct {
		Data []MailThread `json:"data"`
	}
	if st := doJSON(t, "GET", ai.URL+"/v1/collab/threads?box=unread", nil, &list); st != 200 || len(list.Data) != 1 {
		t.Fatalf("list: %d %+v", st, list)
	}
	var detail MailThreadDetail
	if st := doJSON(t, "GET", ai.URL+"/v1/collab/threads/"+m1.ThreadID.String(), nil, &detail); st != 200 || len(detail.Messages) != 1 {
		t.Fatalf("read: %d %+v", st, detail)
	}
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE id = $1 AND unread`, m1.ThreadID); n != 1 {
		t.Fatal("reading marked the conversation read")
	}

	// It saves a reply draft, labelled as its own and audit-logged.
	var d MailMessage
	st := doJSON(t, "POST", ai.URL+"/v1/collab/drafts", map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m1.ID,
		"to": []string{"frank@example.com"}, "subject": "", "body_html": "<p>About $2 each.</p>"}, &d)
	if st != 200 || !d.Draft || d.DraftID == nil || d.DraftedByAI == nil || *d.DraftedByAI != "Local drafter" || d.ThreadID != m1.ThreadID {
		t.Fatalf("create: %d %+v", st, d)
	}
	if n := w.count(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'collab.ai_draft_saved' AND entity_id = $2
		AND actor_user_id = $3`, w.wid, d.ID, w.agent.UserID); n != 1 {
		t.Fatalf("%d audit entries", n)
	}
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE id = $1 AND unread`, m1.ThreadID); n != 1 {
		t.Fatal("drafting marked the conversation read")
	}
	// Saving it again keeps the label; the Gmail sync's view of the new version keeps it too.
	var d2 MailMessage
	if st := doJSON(t, "PUT", ai.URL+"/v1/collab/drafts/"+d.ID.String(), map[string]any{"to": []string{"frank@example.com"},
		"subject": "Re: Quote?", "body_html": "<p>About $1.90 each.</p>"}, &d2); st != 200 || d2.DraftedByAI == nil {
		t.Fatalf("save again: %d %+v", st, d2)
	}
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE id = $1 AND draft AND ai_grant_id = $2`, d.ID, bot.GrantID); n != 1 {
		t.Fatal("the sync dropped the draft's client")
	}

	// It never sends, discards, marks read, assigns or comments.
	refusals := []struct {
		method, path string
		body         any
	}{
		{"POST", "/v1/collab/drafts/" + d.ID.String() + "/send", map[string]any{"to": []string{"frank@example.com"}, "subject": "Re: Quote?",
			"body_html": "<p>Sent by the client</p>"}},
		{"DELETE", "/v1/collab/drafts/" + d.ID.String(), nil},
		{"POST", "/v1/collab/threads/actions", map[string]any{"thread_ids": []uuid.UUID{m1.ThreadID}, "action": "read"}},
		{"PUT", "/v1/collab/threads/" + m1.ThreadID.String() + "/assignees", map[string]any{"user_ids": []uuid.UUID{w.agent.UserID}}},
		{"POST", "/v1/collab/messages", map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m1.ID, "to": []string{"frank@example.com"},
			"subject": "", "body_html": "<p>x</p>"}},
		{"GET", "/v1/collab/counts", nil},
	}
	for _, r := range refusals {
		if st := doJSON(t, r.method, ai.URL+r.path, r.body, &e); st != 403 {
			t.Errorf("%s %s: %d", r.method, r.path, st)
		}
	}
	if len(g.drafts.sent) != 0 || len(g.drafts.deleted) != 0 {
		t.Fatalf("the client reached Gmail: sent %v deleted %v", g.drafts.sent, g.drafts.deleted)
	}
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE id = $1 AND unread`, m1.ThreadID); n != 1 {
		t.Fatal("the conversation was marked read")
	}

	// Replies only, without files.
	if st := doJSON(t, "POST", ai.URL+"/v1/collab/drafts", map[string]any{"account_id": a.ID, "mode": "new", "to": []string{"x@example.com"},
		"subject": "Hi", "body_html": "<p>x</p>"}, &e); st != 403 {
		t.Fatalf("new mail: %d", st)
	}
	if st := doJSON(t, "POST", ai.URL+"/v1/collab/drafts", map[string]any{"account_id": a.ID, "mode": "forward", "message_id": m1.ID,
		"to": []string{"x@example.com"}, "subject": "", "body_html": "<p>x</p>", "forward_attachments": true}, &e); st != 403 {
		t.Fatalf("forward: %d", st)
	}

	// A person's draft is theirs: the client cannot save it again, and once a person saves
	// the client's draft it is theirs too (the label goes).
	human := w.api(w.agent)
	var hd MailMessage
	if st := doJSON(t, "POST", human.URL+"/v1/collab/drafts", map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m1.ID,
		"to": []string{"frank@example.com"}, "subject": "", "body_html": "<p>Mine</p>"}, &hd); st != 200 || hd.DraftedByAI != nil {
		t.Fatalf("person's draft: %d %+v", st, hd)
	}
	if st := doJSON(t, "PUT", ai.URL+"/v1/collab/drafts/"+hd.ID.String(), map[string]any{"to": []string{"frank@example.com"},
		"subject": "Re: Quote?", "body_html": "<p>Overwritten</p>"}, &e); st != 403 {
		t.Fatalf("client saves a person's draft: %d", st)
	}
	var taken MailMessage
	if st := doJSON(t, "PUT", human.URL+"/v1/collab/drafts/"+d.ID.String(), map[string]any{"to": []string{"frank@example.com"},
		"subject": "Re: Quote?", "body_html": "<p>$1.90 each, checked.</p>"}, &taken); st != 200 || taken.DraftedByAI != nil {
		t.Fatalf("person takes the draft over: %d %+v", st, taken)
	}
	if st := doJSON(t, "PUT", ai.URL+"/v1/collab/drafts/"+d.ID.String(), map[string]any{"to": []string{"frank@example.com"},
		"subject": "Re: Quote?", "body_html": "<p>Again</p>"}, &e); st != 403 {
		t.Fatalf("client saves a draft a person took over: %d", st)
	}
	// Another client of the same member does not own the first one's drafts.
	var d3 MailMessage
	doJSON(t, "POST", ai.URL+"/v1/collab/drafts", map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m1.ID,
		"to": []string{"frank@example.com"}, "subject": "", "body_html": "<p>Three</p>"}, &d3)
	other := w.api(w.grant(w.agent, "Other client", auth.ScopeCollabDraft))
	if st := doJSON(t, "PUT", other.URL+"/v1/collab/drafts/"+d3.ID.String(), map[string]any{"to": []string{"frank@example.com"},
		"subject": "Re: Quote?", "body_html": "<p>x</p>"}, &e); st != 403 {
		t.Fatalf("another client: %d", st)
	}
	// The person sends the draft: it goes out as theirs.
	var sent MailMessage
	if st := doJSON(t, "POST", human.URL+"/v1/collab/drafts/"+d.ID.String()+"/send", nil, &sent); st != 200 ||
		sent.SentBy == nil || sent.SentBy.ID != w.agent.UserID || sent.DraftedByAI != nil {
		t.Fatalf("person sends: %d %+v", st, sent)
	}
}

func TestAIClientDraftsAccess(t *testing.T) {
	w := newWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	g.add("m1", "t1", []string{"INBOX", "UNREAD"}, testMail{from: "frank@example.com", to: a.Email, subject: "Hi", msgID: "h1@example.com", body: "Hi"})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	m1 := w.messageByRemote(a, "m1")
	draft := map[string]any{"account_id": a.ID, "mode": "reply", "message_id": m1.ID, "to": []string{"frank@example.com"}, "subject": "", "body_html": "<p>x</p>"}
	var e apiError

	// A grant without collab:draft, an API key and the assistant are refused.
	noScope := w.grant(w.agent, "Tickets only", auth.ScopeTicketsRead, auth.ScopeTicketsWrite)
	key := &auth.Principal{Kind: auth.KindAPIKey, APIKeyID: ids.New(), WorkspaceID: w.wid, Scopes: append(auth.AllScopes, auth.ScopeCollabDraft)}
	assistant := *w.agent
	assistant.ViaAssistant = true
	for name, p := range map[string]*auth.Principal{"grant without scope": noScope, "api key": key, "assistant": &assistant} {
		srv := w.api(p)
		if st := doJSON(t, "GET", srv.URL+"/v1/collab/threads", nil, &e); st != 403 {
			t.Errorf("%s lists: %d", name, st)
		}
		if st := doJSON(t, "POST", srv.URL+"/v1/collab/drafts", draft, &e); st != 403 {
			t.Errorf("%s drafts: %d", name, st)
		}
	}
	// A client sees only what its member sees, and a viewer's client cannot draft.
	outsider := w.api(w.grant(w.agent2, "Bea's client", auth.ScopeCollabDraft))
	if st := doJSON(t, "GET", outsider.URL+"/v1/collab/threads/"+m1.ThreadID.String(), nil, &e); st != 404 {
		t.Fatalf("outsider reads: %d", st)
	}
	if st := doJSON(t, "POST", outsider.URL+"/v1/collab/drafts", draft, &e); st != 404 {
		t.Fatalf("outsider drafts: %d", st)
	}
	viewer := w.api(w.grant(w.viewer, "Vic's client", auth.ScopeCollabDraft))
	if st := doJSON(t, "POST", viewer.URL+"/v1/collab/drafts", draft, &e); st != 403 {
		t.Fatalf("viewer's client drafts: %d", st)
	}
	if len(g.drafts.saves) != 0 {
		t.Fatalf("refused callers saved drafts: %v", g.drafts.saves)
	}
}
