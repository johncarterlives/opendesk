package tickets_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

// The q search finds a ticket through each of its sources: its number and alias, its own
// words and custom fields (full words and prefixes), any of its messages, and its customer's
// name and email. A deleted message and another workspace's tickets never match.
func TestListSearchSources(t *testing.T) {
	e, ws := newEnv(t)
	other := e.NewWorkspace()
	agent := ws.Agent.As(ws)
	addField(t, e, ws, "ticket", "order_id", "text", nil, false)

	aliased := createTicket(t, e, ws, map[string]any{"subject": "Shipping update"})
	e.Do("PATCH", "/v1/tickets/"+aliased.ID.String(), agent, map[string]any{"alias": "PO-7781"}).Want(t, 200)
	subject := createTicket(t, e, ws, map[string]any{"subject": "Claim for P34386 damaged"})
	field := createTicket(t, e, ws, map[string]any{"subject": "Question", "fields": map[string]any{"order_id": "Zephyr-77"}})
	// The order number is in an earlier message, not the latest one the ticket itself keeps.
	message := createTicket(t, e, ws, map[string]any{"subject": "Where is my parcel"})
	inbound(t, e, ws, message.ID, "My order #196120 has not arrived")
	inbound(t, e, ws, message.ID, "Any news?")
	contact := createTicket(t, e, ws, map[string]any{"subject": "Hello", "contact": map[string]any{"email": "ines@harbour.test", "name": "Ines Okafor"}})
	deleted := createTicket(t, e, ws, map[string]any{"subject": "Feedback"})
	gone := inbound(t, e, ws, deleted.ID, "The marmalade was great")
	inbound(t, e, ws, deleted.ID, "Thanks again")
	e.Exec(`UPDATE messages SET deleted_at = now() WHERE id = $1`, gone.ID)

	// The same words in another workspace.
	addField(t, e, other, "ticket", "order_id", "text", nil, false)
	elsewhere := []uuid.UUID{
		createTicket(t, e, other, map[string]any{"subject": "Claim for P34386 elsewhere", "fields": map[string]any{"order_id": "Zephyr-77"},
			"contact": map[string]any{"email": "ines@harbour.test", "name": "Ines Okafor"}}).ID,
		createTicket(t, e, other, map[string]any{"subject": "Shipping update"}).ID,
	}
	inbound(t, e, other, elsewhere[1], "My order #196120 has not arrived")
	inbound(t, e, other, elsewhere[1], "Any news?")

	for _, c := range []struct {
		q    string
		want []uuid.UUID
	}{
		{fmt.Sprintf("#%d", aliased.Number), []uuid.UUID{aliased.ID}},
		{"po-7781", []uuid.UUID{aliased.ID}},
		{"#PO-7781", []uuid.UUID{aliased.ID}},
		{"P34386", []uuid.UUID{subject.ID}},
		{"p3438", []uuid.UUID{subject.ID}}, // prefix on the subject
		{"zephyr", []uuid.UUID{field.ID}},
		{"zeph", []uuid.UUID{field.ID}}, // prefix on a field
		{`"#196120"`, []uuid.UUID{message.ID}},
		{"196120", []uuid.UUID{message.ID}},
		{"okafor", []uuid.UUID{contact.ID}},
		{"okaf", []uuid.UUID{contact.ID}}, // prefix on the customer's name
		{"ines@harbour.test", []uuid.UUID{contact.ID}},
		{"marmalade", []uuid.UUID{}},
		{"Thanks again", []uuid.UUID{deleted.ID}},
	} {
		got := idsOf(list(t, e, agent, "q="+url.QueryEscape(c.q)))
		if !sameSet(got, c.want) {
			t.Errorf("%q: got %v want %v", c.q, got, c.want)
		}
	}
}

// Each source of the q search is its own lookup that reads its index: the search indexes of
// tickets, their fields, messages and contacts, the number key, the alias key and, for one
// address-like word, the address indexes of messages, contacts and their extra addresses. With one
// OR over the ticket's columns and correlated EXISTS, Postgres could use none of them and
// read every ticket of the workspace.
func TestListSearchUsesIndexes(t *testing.T) {
	e, ws := newEnv(t)
	createTicket(t, e, ws, map[string]any{"subject": "First"})
	// A few thousand tickets, each with a contact and a message; VACUUM gives the planner
	// the search indexes' real size.
	e.Exec(`INSERT INTO contacts (workspace_id, name, email)
		SELECT $1, 'Person ' || g, 'person' || g || '@example.com' FROM generate_series(1, 3000) g`, ws.ID)
	e.Exec(`INSERT INTO tickets (workspace_id, number, brand_id, channel, subject, contact_id)
		SELECT $1, 100 + row_number() OVER (), (SELECT brand_id FROM tickets WHERE workspace_id = $1 LIMIT 1), 'api',
			'Order question from ' || c.name, c.id
		FROM contacts c WHERE c.workspace_id = $1 AND c.email LIKE 'person%'`, ws.ID)
	e.Exec(`INSERT INTO messages (workspace_id, ticket_id, author_type, kind, direction, body_text)
		SELECT workspace_id, id, 'contact', 'reply', 'inbound', 'Hello, about ticket ' || number FROM tickets WHERE workspace_id = $1`, ws.ID)
	e.Exec(`INSERT INTO contact_emails (workspace_id, contact_id, email)
		SELECT workspace_id, id, 'other' || substr(email::text, 7) FROM contacts WHERE workspace_id = $1 AND email LIKE 'person%'`, ws.ID)
	e.Exec(`VACUUM ANALYZE tickets, messages, contacts, contact_emails`)

	search := []string{"tickets_search_idx", "tickets_fields_search_idx", "messages_search_idx", "contacts_search_idx"}
	addresses := []string{"messages_addresses_idx", "contacts_address_idx", "contact_emails_address_idx"}
	for _, c := range []struct {
		q       string
		indexes []string
	}{
		{"refund", append(addresses, search...)},
		{"person12@example.com", append(addresses, search...)},
		{"person123", append(addresses, search...)},
		{"refund order", search},
		{"#123", append([]string{"tickets_workspace_id_number_key"}, search...)},
		{"PO-7781", append([]string{"tickets_ws_alias_key"}, search...)},
	} {
		sql, args, err := tickets.SearchSQL(ws.ID, c.q)
		if err != nil {
			t.Fatal(err)
		}
		var plan json.RawMessage
		e.Scalar("EXPLAIN (FORMAT JSON) "+sql, &plan, args...)
		used, seq := planScans(t, plan)
		for _, idx := range c.indexes {
			if !slices.Contains(used, idx) {
				t.Errorf("%q: %s not used; the plan reads %v\n%s", c.q, idx, used, plan)
			}
		}
		// Only the list's own scan of the tickets (t) may be sequential: on tables this
		// small, the planner may rather hash the matching ids than look each one up.
		for _, alias := range seq {
			if alias != "t" {
				t.Errorf("%q: sequential scan of %s\n%s", c.q, alias, plan)
			}
		}
	}
}

// planScans lists the indexes an EXPLAIN (FORMAT JSON) plan reads, and the aliases of the
// tables it scans sequentially.
func planScans(t *testing.T, raw json.RawMessage) (indexes, seq []string) {
	t.Helper()
	var plans []struct {
		Plan map[string]any `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &plans); err != nil {
		t.Fatal(err)
	}
	var walk func(n map[string]any)
	walk = func(n map[string]any) {
		if idx, ok := n["Index Name"].(string); ok {
			indexes = append(indexes, idx)
		}
		if n["Node Type"] == "Seq Scan" {
			alias, _ := n["Alias"].(string)
			seq = append(seq, alias)
		}
		children, _ := n["Plans"].([]any)
		for _, c := range children {
			if m, ok := c.(map[string]any); ok {
				walk(m)
			}
		}
	}
	for _, p := range plans {
		walk(p.Plan)
	}
	return indexes, seq
}
