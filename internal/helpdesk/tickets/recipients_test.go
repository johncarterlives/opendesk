package tickets_test

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// TestNewTicketToSeveral checks POST /v1/tickets "to": the contact is the ticket's and the first
// address, the others follow on the first email's To, and only this workspace's contacts count.
func TestNewTicketToSeveral(t *testing.T) {
	e, ws := newEnv(t)
	mb := addMailbox(t, e, ws)
	contact := func(wid uuid.UUID, name string, email any) uuid.UUID {
		id := ids.New()
		e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, $3, $4)`, id, wid, name, email)
		return id
	}
	other := contact(ws.ID, "Olga", "olga@example.com")

	tk := createTicket(t, e, ws, map[string]any{"mailbox_id": mb.String(), "contact": map[string]any{"email": "buyer@example.com"},
		"to": []map[string]any{{"contact_id": other.String()}, {"email": "Deputy@Example.com"}, {"email": "buyer@example.com"}, {"email": "deputy@example.com"}},
		"cc": []string{"boss@example.com"}})
	if tk.Contact == nil || tk.Contact.Email == nil || *tk.Contact.Email != "buyer@example.com" {
		t.Fatalf("ticket contact %+v", tk.Contact)
	}
	var msgs struct{ Data []domain.Message }
	e.Do("GET", "/v1/tickets/"+tk.ID.String()+"/messages", ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &msgs)
	m := msgs.Data[0]
	if len(m.To) != 3 || m.To[0] != "buyer@example.com" || m.To[1] != "olga@example.com" || m.To[2] != "deputy@example.com" || len(m.Cc) != 1 {
		t.Fatalf("first email to %v cc %v", m.To, m.Cc)
	}
	if n := len(e.Jobs(jobs.SendMessageArgs{}.Kind(), ws.ID)); n != 1 {
		t.Fatalf("send jobs %d", n)
	}

	base := func(extra map[string]any) map[string]any {
		b := map[string]any{"subject": "Help needed", "body_html": "<p>Hi</p>", "mailbox_id": mb.String(), "contact": map[string]any{"email": "buyer@example.com"}}
		for k, v := range extra {
			b[k] = v
		}
		return b
	}
	// Another workspace's contact, a contact without an address, a bad address, both or neither.
	ws2 := e.NewWorkspace()
	foreign := contact(ws2.ID, "Fay", "fay@example.com")
	noEmail := contact(ws.ID, "Nomail", nil)
	for name, to := range map[string][]map[string]any{
		"foreign":  {{"contact_id": foreign.String()}},
		"no email": {{"contact_id": noEmail.String()}},
		"bad":      {{"email": "not an address"}},
		"both":     {{"contact_id": other.String(), "email": "x@example.com"}},
		"neither":  {{}},
		"unknown":  {{"contact_id": uuid.NewString()}},
	} {
		if r := e.Do("POST", "/v1/tickets", ws.Agent.As(ws), base(map[string]any{"to": to})); r.Status != 422 {
			t.Errorf("%s: %d", name, r.Status)
		}
	}
	twenty := make([]map[string]any, 20)
	for i := range twenty {
		twenty[i] = map[string]any{"email": "p" + string(rune('a'+i)) + "@example.com"}
	}
	e.Do("POST", "/v1/tickets", ws.Agent.As(ws), base(map[string]any{"to": twenty})).Want(t, 422)
	// Only for an emailed first reply.
	one := []map[string]any{{"email": "x@example.com"}}
	e.Do("POST", "/v1/tickets", ws.Agent.As(ws), base(map[string]any{"to": one, "kind": "note"})).Want(t, 422)
	e.Do("POST", "/v1/tickets", ws.Agent.As(ws), base(map[string]any{"to": one, "direction": "inbound"})).Want(t, 422)
	e.Do("POST", "/v1/tickets", ws.Agent.As(ws), map[string]any{"subject": "x", "body_html": "<p>x</p>", "channel": "api",
		"contact": map[string]any{"email": "buyer@example.com"}, "to": one}).Want(t, 422)
}

// TestReplyDraftRecipients checks that a reply draft keeps who it goes to and the address it goes
// from, and gives back only an address and an account that are still there to send from.
func TestReplyDraftRecipients(t *testing.T) {
	e, ws := newEnv(t)
	mb := addMailbox(t, e, ws)
	tk := createTicket(t, e, ws, map[string]any{"mailbox_id": mb.String(), "kind": "note", "body_html": "<p>x</p>",
		"contact": map[string]any{"email": "buyer@example.com"}})
	path := "/v1/tickets/" + tk.ID.String() + "/reply-draft"
	var got struct{ Draft *tickets.ReplyDraft }

	// Without recipients: the customer's reply address and no copies.
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>Plain</p>"}).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.To != nil || len(got.Draft.Cc) != 0 || got.Draft.MailboxID != nil || got.Draft.FromAccount != nil {
		t.Fatalf("plain draft %+v", got.Draft)
	}

	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>Half</p>", "to": []string{"Owner@Example.com", "buyer@example.com"},
		"cc": []string{"boss@example.com"}, "bcc": []string{"audit@example.com"}, "mailbox_id": mb.String()}).Want(t, 200)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	d := got.Draft
	if d == nil || len(d.To) != 2 || d.To[0] != "owner@example.com" || len(d.Cc) != 1 || d.Cc[0] != "boss@example.com" ||
		len(d.Bcc) != 1 || d.MailboxID == nil || *d.MailboxID != mb {
		t.Fatalf("draft recipients %+v", d)
	}

	// An address turned off is not offered back; the words and copies stay.
	e.Exec(`UPDATE mailboxes SET status = 'disabled' WHERE id = $1`, mb)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.MailboxID != nil || len(got.Draft.Cc) != 1 {
		t.Fatalf("draft with a disabled address %+v", got.Draft)
	}
	e.Exec(`UPDATE mailboxes SET status = 'active' WHERE id = $1`, mb)

	// Refused: bad addresses, another workspace's address, both from fields, an account not seen.
	ws2 := e.NewWorkspace()
	mb2 := addMailbox(t, e, ws2)
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>x</p>", "cc": []string{"nope"}}).Want(t, 422)
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>x</p>", "mailbox_id": mb2.String()}).Want(t, 422)
	account := ids.New()
	e.Exec(`INSERT INTO collab_accounts (id, workspace_id, owner_id, provider, email, name, visibility, credentials_enc, status)
		VALUES ($1, $2, $3, 'google', $4, $4, 'private', '\x00', 'active')`, account, ws.ID, ws.Agent.ID, "anna-"+account.String()[24:]+"@acme.test")
	from := map[string]any{"account_id": account.String(), "email": "anna-" + account.String()[24:] + "@acme.test", "reply_to": "mailbox"}
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>x</p>", "mailbox_id": mb.String(), "from_account": from}).Want(t, 422)
	e.Do("PUT", path, ws.Admin.As(ws), map[string]any{"body_html": "<p>x</p>", "from_account": from}).Want(t, 422)

	// My own Collab address comes back while I see its account.
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "<p>From me</p>", "from_account": from}).Want(t, 200)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if f := got.Draft.FromAccount; f == nil || f.AccountID != account || f.ReplyTo != "mailbox" || got.Draft.To != nil {
		t.Fatalf("from account %+v", got.Draft)
	}
	e.Exec(`DELETE FROM collab_accounts WHERE id = $1`, account)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || got.Draft.FromAccount != nil {
		t.Fatalf("a gone account came back %+v", got.Draft)
	}

	// A scheduled reply's recipients stay in the draft once the schedule is cancelled.
	at := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	e.Do("POST", path+"/schedule", ws.Agent.As(ws), map[string]any{"send_at": at,
		"reply": map[string]any{"kind": "reply", "body_html": "<p>Later</p>", "cc": []string{"later@example.com"}}}).Want(t, 200)
	e.Do("DELETE", path+"/schedule", ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Draft == nil || len(got.Draft.Cc) != 1 || got.Draft.Cc[0] != "later@example.com" || got.Draft.FromAccount != nil {
		t.Fatalf("draft after cancelling its schedule %+v", got.Draft)
	}

	// Recipients alone are no draft.
	e.Do("PUT", path, ws.Agent.As(ws), map[string]any{"body_html": "", "cc": []string{"boss@example.com"}}).Want(t, 200).JSON(t, &got)
	if got.Draft != nil {
		t.Fatalf("recipients without words kept a draft %+v", got.Draft)
	}
}
