package tickets_test

import (
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

// mail adds a message from, to and cc'd the given addresses.
func mail(t *testing.T, e *hdtest.Env, ws hdtest.WS, tid uuid.UUID, from string, to, cc []string) {
	t.Helper()
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		_, err := domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: ws.ID, TicketID: tid, Kind: "reply",
			Direction: "inbound", AuthorType: "contact", BodyHTML: "<p>About my order</p>", BodyText: "About my order",
			FromEmail: from, To: to, Cc: cc})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A query that is an address finds the tickets of that address: its contact's, primary or
// extra address, and those with a message from, to or cc'd it. Part of an address (its local
// part, its domain or the domain's first word) finds them too. A private team's ticket stays
// hidden from who may not see it, and another workspace's never shows.
func TestSearchFindsAddresses(t *testing.T) {
	e, ws := newEnv(t)
	agent := ws.Agent.As(ws)
	primary := createTicket(t, e, ws, map[string]any{"subject": "Order 1", "contact": map[string]any{"email": "buyer@shop-one.example.com", "name": "Bea Buyer"}})
	extra := createTicket(t, e, ws, map[string]any{"subject": "Order 2", "contact": map[string]any{"email": "dana@example.org", "name": "Dana"}})
	e.Exec(`INSERT INTO contact_emails (workspace_id, contact_id, email) VALUES ($1, $2, 'dana.alt@shop-one.example.com')`, ws.ID, extra.Contact.ID)
	sender := createTicket(t, e, ws, map[string]any{"subject": "Order 3"})
	mail(t, e, ws, sender.ID, "Orders+eu@Tradeplace.example.net", nil, nil)
	copied := createTicket(t, e, ws, map[string]any{"subject": "Order 4"})
	mail(t, e, ws, copied.ID, "someone@example.org", []string{"help@acme.test"}, []string{"accounts@tradeplace.example.net"})
	// Mentions the domain's first word only in its text: found by the word, not by an address.
	mention := createTicket(t, e, ws, map[string]any{"subject": "Order 5", "body_html": "<p>I saw tradeplacement offers</p>"})
	unrelated := createTicket(t, e, ws, map[string]any{"subject": "Something else"})
	private := addTeam(t, e, ws, ws.Agent.ID)
	e.Exec(`UPDATE teams SET private = true WHERE id = $1`, private)
	secret := createTicket(t, e, ws, map[string]any{"subject": "Private order", "team_id": private.String(),
		"contact": map[string]any{"email": "vip@tradeplace.example.net"}})
	other := e.NewWorkspace()
	createTicket(t, e, other, map[string]any{"subject": "Elsewhere", "contact": map[string]any{"email": "buyer@shop-one.example.com"}})
	_ = unrelated

	for _, c := range []struct {
		q    string
		want []uuid.UUID
	}{
		{"buyer@shop-one.example.com", []uuid.UUID{primary.ID}},
		{"BUYER@shop-one.example.com", []uuid.UUID{primary.ID}},
		{"dana.alt@shop-one.example.com", []uuid.UUID{extra.ID}},
		{"shop-one.example.com", []uuid.UUID{primary.ID, extra.ID}},
		{"shop-one", []uuid.UUID{primary.ID, extra.ID}},
		{"orders+eu@tradeplace.example.net", []uuid.UUID{sender.ID}},
		{"accounts@tradeplace.example.net", []uuid.UUID{copied.ID}},
		{"tradeplace.example.net", []uuid.UUID{sender.ID, copied.ID, secret.ID}},
		{"tradeplace.example", []uuid.UUID{sender.ID, copied.ID, secret.ID}},
		{"tradeplace", []uuid.UUID{sender.ID, copied.ID, secret.ID, mention.ID}},
		{"tradepl", []uuid.UUID{sender.ID, copied.ID, secret.ID, mention.ID}},
		{"nobody@tradeplace.example.net", []uuid.UUID{}},
	} {
		if got := idsOf(list(t, e, agent, "q="+url.QueryEscape(c.q))); !sameSet(got, c.want) {
			t.Errorf("%q: got %v want %v", c.q, got, c.want)
		}
	}
	// The viewer is not on the private team.
	if got := idsOf(list(t, e, ws.Viewer.As(ws), "q=tradeplace.example.net")); !sameSet(got, []uuid.UUID{sender.ID, copied.ID}) {
		t.Errorf("viewer: got %v", got)
	}

	// The search palette lists the address's tickets first, then those that only mention it,
	// and finds the contacts by part of their addresses.
	var res tickets.SearchResults
	e.Do("GET", "/v1/search?q=tradeplace", agent, nil).Want(t, 200).JSON(t, &res)
	got := []uuid.UUID{}
	for _, tk := range res.Tickets {
		got = append(got, tk.ID)
	}
	if len(got) != 4 || got[3] != mention.ID || !sameSet(got[:3], []uuid.UUID{sender.ID, copied.ID, secret.ID}) {
		t.Errorf("palette tickets %v, mention %v last", got, mention.ID)
	}
	e.Do("GET", "/v1/search?q=shop-one.example", agent, nil).Want(t, 200).JSON(t, &res)
	contacts := []uuid.UUID{}
	for _, c := range res.Contacts {
		contacts = append(contacts, c.ID)
	}
	if !sameSet(contacts, []uuid.UUID{primary.Contact.ID, extra.Contact.ID}) {
		t.Errorf("palette contacts %v", contacts)
	}
	e.Do("GET", "/v1/search?q=tradeplace.example.net", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &res)
	for _, tk := range res.Tickets {
		if tk.ID == secret.ID {
			t.Error("palette showed a private team's ticket to the viewer")
		}
	}
}

// The palette returns up to 8 tickets.
func TestSearchPaletteLimit(t *testing.T) {
	e, ws := newEnv(t)
	for range 10 {
		createTicket(t, e, ws, map[string]any{"subject": "Refund request"})
	}
	var res tickets.SearchResults
	e.Do("GET", "/v1/search?q=refund", ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &res)
	if len(res.Tickets) != 8 {
		t.Fatalf("tickets %d", len(res.Tickets))
	}
}

// Message text matches word prefixes too, as subjects do.
func TestSearchMessagePrefix(t *testing.T) {
	e, ws := newEnv(t)
	tk := createTicket(t, e, ws, map[string]any{"subject": "Hello"})
	inbound(t, e, ws, tk.ID, "The parcel was damaged")
	inbound(t, e, ws, tk.ID, "Any news?")
	if got := idsOf(list(t, e, ws.Agent.As(ws), "q=damag")); !sameSet(got, []uuid.UUID{tk.ID}) {
		t.Fatalf("got %v", got)
	}
}
