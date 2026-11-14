package tickets_test

import (
	"testing"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

func TestDeleteRecordsWho(t *testing.T) {
	e, ws := newEnv(t)
	a := createTicket(t, e, ws, map[string]any{"subject": "A"})
	b := createTicket(t, e, ws, map[string]any{"subject": "B"})

	// Agents delete, alone or in bulk; the ticket and the audit log say who.
	e.Do("DELETE", "/v1/tickets/"+a.ID.String(), ws.Agent.As(ws), nil).Want(t, 204)
	var who string
	e.Scalar(`SELECT coalesce(actor_user_id::text, '') FROM audit_logs WHERE entity_id = $1 AND action = 'ticket.deleted' AND (data->>'number')::bigint = $2`, &who, a.ID, a.Number)
	if who != ws.Agent.ID.String() {
		t.Fatalf("audit actor %q, want the agent", who)
	}
	if n := countRows(t, e, `SELECT count(*) FROM tickets WHERE id = $1 AND deleted_by = $2 AND deleted_by_api_key_id IS NULL`, a.ID, ws.Agent.ID); n != 1 {
		t.Fatal("deleted_by not the agent")
	}
	if n := countRows(t, e, `SELECT count(*) FROM activities WHERE ticket_id = $1 AND type = 'deleted' AND actor_user_id = $2`, a.ID, ws.Agent.ID); n != 1 {
		t.Fatalf("deleted by the agent on the timeline %d", n)
	}
	key := e.APIKey(ws, "tickets:read", "tickets:write")
	e.Do("POST", "/v1/tickets/bulk", hdtest.Auth{Bearer: key, Workspace: ws.ID}, map[string]any{"ids": []string{b.ID.String()}, "delete": true}).Want(t, 200)
	if n := countRows(t, e, `SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action = 'ticket.deleted' AND actor_api_key_id IS NOT NULL`, b.ID); n != 1 {
		t.Fatalf("key's delete audited %d", n)
	}
	if n := countRows(t, e, `SELECT count(*) FROM tickets WHERE id = $1 AND deleted_by IS NULL AND deleted_by_api_key_id IS NOT NULL`, b.ID); n != 1 {
		t.Fatal("deleted_by_api_key_id not the key")
	}
}

func TestTrash(t *testing.T) {
	e, ws := newEnv(t)
	a := createTicket(t, e, ws, map[string]any{"subject": "Deleted by the agent"})
	b := createTicket(t, e, ws, map[string]any{"subject": "Deleted by a key"})
	c := createTicket(t, e, ws, map[string]any{"subject": "Merged, then deleted"})
	live := createTicket(t, e, ws, map[string]any{"subject": "Still here"})
	inbound(t, e, ws, a.ID, "a reply")

	e.Do("POST", "/v1/tickets/bulk", ws.Agent.As(ws), map[string]any{"ids": []string{a.ID.String()}, "delete": true}).Want(t, 200)
	key := e.APIKey(ws, "tickets:read", "tickets:write")
	e.Do("DELETE", "/v1/tickets/"+b.ID.String(), hdtest.Auth{Bearer: key, Workspace: ws.ID}, nil).Want(t, 204)
	e.Do("POST", "/v1/tickets/"+c.ID.String()+"/merge", ws.Agent.As(ws), map[string]any{"into_id": live.ID.String()}).Want(t, 200)
	e.Do("DELETE", "/v1/tickets/"+c.ID.String(), ws.Admin.As(ws), nil).Want(t, 204)

	// Who deleted is on the ticket.
	var by, byKey string
	e.Scalar(`SELECT coalesce(deleted_by::text, '') || '|' || coalesce(deleted_by_api_key_id::text, '') FROM tickets WHERE id = $1`, &by, a.ID)
	if by != ws.Agent.ID.String()+"|" {
		t.Fatalf("a deleted_by %q", by)
	}
	e.Scalar(`SELECT coalesce(deleted_by::text, '') || '|' || (deleted_by_api_key_id IS NOT NULL)::text FROM tickets WHERE id = $1`, &byKey, b.ID)
	if byKey != "|true" {
		t.Fatalf("b deleted_by %q", byKey)
	}

	// Admins only, and the static path is not read as a ticket id.
	e.Do("GET", "/v1/tickets/deleted", ws.Agent.As(ws), nil).Want(t, 403)
	e.Do("POST", "/v1/tickets/"+a.ID.String()+"/restore", ws.Agent.As(ws), nil).Want(t, 403)
	var page struct {
		Data       []tickets.DeletedTicket
		NextBefore string `json:"next_before"`
	}
	e.Do("GET", "/v1/tickets/deleted", ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 3 || page.NextBefore != "" {
		t.Fatalf("trash %+v", page)
	}
	byID := map[string]tickets.DeletedTicket{}
	for _, d := range page.Data {
		byID[d.ID.String()] = d
	}
	if d := byID[a.ID.String()]; d.DeletedBy == nil || d.DeletedBy.ID != ws.Agent.ID || d.MessageCount != 2 || d.DeletedAt.IsZero() {
		t.Fatalf("a in trash %+v", d)
	}
	if d := byID[b.ID.String()]; d.DeletedBy != nil || d.DeletedByAPIKey == nil {
		t.Fatalf("b in trash %+v", d)
	}
	if d := byID[c.ID.String()]; d.MergedIntoNumber == nil || *d.MergedIntoNumber != live.Number {
		t.Fatalf("c in trash %+v", d)
	}
	// Paging one by one walks the three, then stops; q finds by subject or number.
	seen := 0
	for before := ""; ; {
		page.NextBefore = "" // absent on the last page
		e.Do("GET", "/v1/tickets/deleted?limit=1&before="+before, ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &page)
		seen += len(page.Data)
		if page.NextBefore == "" {
			break
		}
		before = page.NextBefore
		if seen > 3 {
			t.Fatal("paging loops")
		}
	}
	if seen != 3 {
		t.Fatalf("paged %d", seen)
	}
	e.Do("GET", "/v1/tickets/deleted?q=by%20a%20key", ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 1 || page.Data[0].ID != b.ID {
		t.Fatalf("q subject %+v", page.Data)
	}
	e.Do("GET", hdtest.Fmt("/v1/tickets/deleted?q=%%23%d", a.Number), ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 1 || page.Data[0].ID != a.ID {
		t.Fatalf("q number %+v", page.Data)
	}
	e.Do("GET", "/v1/tickets/deleted?before=nope", ws.Admin.As(ws), nil).Want(t, 422)

	// Restore: back as it was, who restored is on the timeline, deleted_by is cleared.
	var back domain.Ticket
	e.Do("POST", hdtest.Fmt("/v1/tickets/%d/restore", a.Number), ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &back)
	if back.ID != a.ID || back.Status != "open" || back.MessageCount != 2 {
		t.Fatalf("restored %+v", back)
	}
	getTicket(t, e, ws, a.ID)
	if n := countRows(t, e, `SELECT count(*) FROM activities WHERE ticket_id = $1 AND type = 'restored' AND actor_user_id = $2`, a.ID, ws.Admin.ID); n != 1 {
		t.Fatalf("restored by the admin %d", n)
	}
	if n := countRows(t, e, `SELECT count(*) FROM tickets WHERE id = $1 AND deleted_by IS NULL AND deleted_by_api_key_id IS NULL`, a.ID); n != 1 {
		t.Fatal("deleted_by not cleared")
	}
	if n := countRows(t, e, `SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action = 'ticket.restored' AND actor_user_id = $2 `, a.ID, ws.Admin.ID); n != 1 {
		t.Fatalf("restore audit %d", n)
	}
	// Twice, a live ticket, a merged shell, another workspace's ticket.
	e.Do("POST", "/v1/tickets/"+a.ID.String()+"/restore", ws.Admin.As(ws), nil).Want(t, 404)
	e.Do("POST", "/v1/tickets/"+live.ID.String()+"/restore", ws.Admin.As(ws), nil).Want(t, 404)
	e.Do("POST", "/v1/tickets/"+c.ID.String()+"/restore", ws.Admin.As(ws), nil).Want(t, 409)
	e.Do("POST", "/v1/tickets/nope/restore", ws.Admin.As(ws), nil).Want(t, 404)
	other := e.NewWorkspace()
	e.Do("POST", "/v1/tickets/"+b.ID.String()+"/restore", other.Admin.As(other), nil).Want(t, 404)
	e.Do("GET", "/v1/tickets/deleted", ws.Admin.As(ws), nil).Want(t, 200).JSON(t, &page)
	if len(page.Data) != 2 {
		t.Fatalf("trash after restore %+v", page.Data)
	}
}
