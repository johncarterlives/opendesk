package customerportal

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

const portalTickets = "/v1/customer/portal/tickets"

func ticketSession(t *testing.T) (*hdtest.Env, hdtest.WS, uuid.UUID, hdtest.Auth) {
	t.Helper()
	e, ws, cid, email := portalEnv(t)
	reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)
	access, _ := signIn(t, e, ws, email)
	return e, ws, cid, hdtest.Auth{Bearer: access}
}
func portalTicket(t *testing.T, e *hdtest.Env, ws hdtest.WS, cid uuid.UUID, status string) domain.Ticket {
	t.Helper()
	var ticket domain.Ticket
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		var err error
		ticket, err = domain.CreateTicket(e.Ctx, tx, domain.NewTicket{WorkspaceID: ws.ID, ContactID: &cid, Channel: domain.ChannelEmail, Subject: "Customer question", Status: status})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}
func portalMessage(t *testing.T, e *hdtest.Env, ws hdtest.WS, ticket domain.Ticket, kind, text string) domain.Message {
	t.Helper()
	var m domain.Message
	err := e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		var err error
		m, err = domain.AddMessage(e.Ctx, tx, e.D.Jobs, domain.NewMessage{WorkspaceID: ws.ID, TicketID: ticket.ID, Kind: kind, Direction: "outbound", AuthorType: "user", AuthorUserID: &ws.Agent.ID, BodyText: text, BodyHTML: "<p>" + text + "</p>", Trigger: "none"})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func pageRows(t *testing.T, r *hdtest.Resp) ([]map[string]any, *string) {
	t.Helper()
	var p struct {
		Data       []map[string]any `json:"data"`
		NextCursor *string          `json:"next_cursor"`
	}
	r.Want(t, 200).JSON(t, &p)
	return p.Data, p.NextCursor
}
func TestPortalTicketOwnership(t *testing.T) {
	e, ws, cid, customer := ticketSession(t)
	own := portalTicket(t, e, ws, cid, domain.StatusOpen)
	team := ids.New()
	e.Exec(`INSERT INTO teams(id,workspace_id,name,private) VALUES($1,$2,'Private team',true)`, team, ws.ID)
	e.Exec(`UPDATE tickets SET team_id=$2, custom='{"secret":"internal"}',last_message_preview='private preview' WHERE id=$1`, own.ID, team)
	otherContact := ids.New()
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,'other@example.com','Other')`, otherContact, ws.ID)
	other := portalTicket(t, e, ws, otherContact, domain.StatusOpen)
	otherWS := e.NewWorkspace()
	foreignContact := ids.New()
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,'foreign@example.com','Foreign')`, foreignContact, otherWS.ID)
	foreign := portalTicket(t, e, otherWS, foreignContact, domain.StatusOpen)
	spam := portalTicket(t, e, ws, cid, domain.StatusOpen)
	deleted := portalTicket(t, e, ws, cid, domain.StatusOpen)
	e.Exec(`UPDATE tickets SET spam=true WHERE id=$1`, spam.ID)
	e.Exec(`UPDATE tickets SET deleted_at=now() WHERE id=$1`, deleted.ID)
	for _, tk := range []domain.Ticket{other, foreign, spam, deleted} {
		for _, suffix := range []string{"", "/messages"} {
			e.Do("GET", portalTickets+"/"+tk.ID.String()+suffix, customer, nil).Want(t, 404)
		}
		e.Do("POST", portalTickets+"/"+tk.ID.String()+"/messages", customer, map[string]any{"body": "Not mine"}).Want(t, 404)
	}
	e.Do("GET", portalTickets+"/not-an-id", customer, nil).Want(t, 404)
	r := e.Do("GET", portalTickets+"/"+own.ID.String(), customer, nil).Want(t, 200)
	m := r.Map(t)
	delete(m, "$schema")
	if len(m) != 6 || m["id"] != own.ID.String() || strings.Contains(string(r.Body), "private preview") || strings.Contains(string(r.Body), "internal") {
		t.Fatalf("ticket DTO: %s", r.Body)
	}
	rows, next := pageRows(t, e.Do("GET", portalTickets+"?workspace_id="+otherWS.ID.String()+"&contact_id="+otherContact.String(), customer, nil))
	if len(rows) != 1 || rows[0]["id"] != own.ID.String() || next != nil {
		t.Fatalf("scoped list: %+v", rows)
	}
	// Internal private-team assignment does not restrict this contact's replies.
	path := portalTickets + "/" + own.ID.String() + "/messages"
	for _, field := range []string{"workspace_id", "contact_id", "attachment_ids", "cc", "status", "thread_id", "body_html"} {
		e.Do("POST", path, customer, map[string]any{"body": "Hello", field: "unsupported"}).Want(t, 422)
	}
	e.Do("POST", path, customer, map[string]any{"body": "Private team reply"}).Want(t, 201)
	public, _ := pageRows(t, e.Do("GET", path, customer, nil))
	if len(public) != 1 || public[0]["body_text"] != "Private team reply" {
		t.Fatalf("private-team conversation: %+v", public)
	}
	for _, credential := range []hdtest.Auth{{}, ws.Agent.As(ws), {Bearer: e.APIKey(ws, "tickets:read", "tickets:write")}} {
		e.Do("GET", portalTickets, credential, nil).Want(t, 401)
		e.Do("GET", portalTickets+"/"+own.ID.String(), credential, nil).Want(t, 401)
		e.Do("GET", portalTickets+"/"+own.ID.String()+"/messages", credential, nil).Want(t, 401)
		e.Do("POST", portalTickets+"/"+own.ID.String()+"/messages", credential, map[string]any{"body": "No customer"}).Want(t, 401)
	}
}
func TestPortalTicketPagination(t *testing.T) {
	e, ws, cid, customer := ticketSession(t)
	var want []string
	for i := 0; i < 5; i++ {
		tk := portalTicket(t, e, ws, cid, domain.StatusOpen)
		e.Exec(`UPDATE tickets SET updated_at='2026-01-01T12:00:00Z' WHERE id=$1`, tk.ID)
		want = append([]string{tk.ID.String()}, want...)
	}
	var got []string
	path := portalTickets + "?limit=2"
	for {
		rows, next := pageRows(t, e.Do("GET", path, customer, nil))
		if len(rows) > 2 {
			t.Fatal("page not bounded")
		}
		for _, row := range rows {
			got = append(got, row["id"].(string))
		}
		if next == nil {
			break
		}
		path = portalTickets + "?limit=2&cursor=" + url.QueryEscape(*next)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ticket order: %v, want %v", got, want)
	}
	for _, query := range []string{"limit=0", "limit=101"} {
		e.Do("GET", portalTickets+"?"+query, customer, nil).Want(t, 422)
	}
	for _, query := range []string{"cursor=broken", "cursor=e30"} {
		e.Do("GET", portalTickets+"?"+query, customer, nil).Want(t, 400)
	}
}
func TestPortalPublicMessages(t *testing.T) {
	e, ws, cid, customer := ticketSession(t)
	tk := portalTicket(t, e, ws, cid, domain.StatusOpen)
	path := portalTickets + "/" + tk.ID.String() + "/messages"
	first := portalMessage(t, e, ws, tk, "reply", "Public first")
	portalMessage(t, e, ws, tk, "note", "Private note")
	failed := portalMessage(t, e, ws, tk, "reply", "Failed sender")
	e.Exec(`UPDATE messages SET auth_failed=true WHERE id=$1`, failed.ID)
	deleted := portalMessage(t, e, ws, tk, "reply", "Deleted reply")
	e.Exec(`UPDATE messages SET deleted_at=now() WHERE id=$1`, deleted.ID)
	purged := portalMessage(t, e, ws, tk, "reply", "Purged reply")
	e.Exec(`UPDATE messages SET purged_at=now() WHERE id=$1`, purged.ID)
	marker := portalMessage(t, e, ws, tk, "reply", "Retracted marker")
	e.Exec(`UPDATE messages SET sent_as_reply_id=$2 WHERE id=$1`, marker.ID, first.ID)
	thread := ids.New()
	e.Exec(`INSERT INTO ticket_threads(id,workspace_id,ticket_id,subject,to_emails,created_by) VALUES($1,$2,$3,'Private thread',ARRAY['third@example.com'],$4)`, thread, ws.ID, tk.ID, ws.Agent.ID)
	side := portalMessage(t, e, ws, tk, "note", "Private thread content")
	e.Exec(`UPDATE messages SET thread_id=$2 WHERE id=$1`, side.ID, thread)
	second := portalMessage(t, e, ws, tk, "reply", "Public second")
	// A tie in creation time still has a stable ID order.
	e.Exec(`UPDATE messages SET created_at='2026-01-01T12:00:00Z' WHERE id=ANY($1)`, []uuid.UUID{first.ID, second.ID})
	rows, next := pageRows(t, e.Do("GET", path+"?limit=1", customer, nil))
	if len(rows) != 1 || rows[0]["id"] != first.ID.String() || len(rows[0]) != 4 || next == nil {
		t.Fatalf("first message page: %+v", rows)
	}
	rows, next = pageRows(t, e.Do("GET", path+"?limit=1&cursor="+url.QueryEscape(*next), customer, nil))
	if len(rows) != 1 || rows[0]["id"] != second.ID.String() || rows[0]["body_text"] != "Public second" || next != nil {
		t.Fatalf("public message page: %+v", rows)
	}
	r := e.Do("GET", path, customer, nil).Want(t, 200)
	for _, hidden := range []string{"Private", "Failed sender", "Deleted reply", "Purged reply", "Retracted marker", "body_html", "author_user_id", "from_email", "attachment", "thread_id"} {
		if strings.Contains(string(r.Body), hidden) {
			t.Fatalf("hidden message data %q: %s", hidden, r.Body)
		}
	}
	e.Do("GET", path+"?limit=101", customer, nil).Want(t, 422)
	e.Do("GET", path+"?cursor=broken", customer, nil).Want(t, 400)
}
func TestPortalReply(t *testing.T) {
	for _, status := range []string{domain.StatusOpen, domain.StatusPending, domain.StatusOnHold, domain.StatusSolved, domain.StatusClosed} {
		t.Run(status, func(t *testing.T) {
			e, ws, cid, customer := ticketSession(t)
			tk := portalTicket(t, e, ws, cid, status)
			text := "<script>alert('hi')</script>\nThanks & goodbye"
			_, before := e.Events(ws.ID, 0)
			r := e.Do("POST", portalTickets+"/"+tk.ID.String()+"/messages", customer, map[string]any{"body": text}).Want(t, 201)
			m := r.Map(t)
			delete(m, "$schema")
			if len(m) != 4 || m["body_text"] != text || m["direction"] != "inbound" {
				t.Fatalf("reply DTO: %s", r.Body)
			}
			var author, kind, direction, html, delivery string
			var contact uuid.UUID
			var user *uuid.UUID
			if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT author_type,author_contact_id,author_user_id,kind,direction,body_html,delivery_status FROM messages WHERE id=$1`, m["id"]).Scan(&author, &contact, &user, &kind, &direction, &html, &delivery); err != nil {
				t.Fatal(err)
			}
			if author != "contact" || contact != cid || user != nil || kind != "reply" || direction != "inbound" || delivery != "none" || strings.Contains(html, "<script>") || !strings.Contains(html, "&lt;script&gt;") || !strings.Contains(html, "&amp;") {
				t.Fatalf("unsafe or misattributed reply: %s %s %s", author, direction, html)
			}
			var current string
			var waiting *time.Time
			var count int
			if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT status,waiting_since,unanswered_count FROM tickets WHERE id=$1`, tk.ID).Scan(&current, &waiting, &count); err != nil {
				t.Fatal(err)
			}
			want := domain.StatusOpen
			if status == domain.StatusClosed {
				want = status
			}
			if current != want || waiting == nil || count != 1 {
				t.Fatalf("reply bookkeeping: %s %v %d", current, waiting, count)
			}
			types, _ := e.Events(ws.ID, before)
			if !strings.Contains(strings.Join(types, ","), "message.created") || !strings.Contains(strings.Join(types, ","), "ticket.updated") {
				t.Fatalf("missing events: %v", types)
			}
			queued := e.Jobs(jobs.TicketTriggerArgs{}.Kind(), ws.ID)
			if len(queued) != 1 {
				t.Fatalf("reply jobs: %s", queued)
			}
			var a jobs.TicketTriggerArgs
			if err := json.Unmarshal(queued[0], &a); err != nil {
				t.Fatal(err)
			}
			if a.Trigger != jobs.TriggerCustomerReplied || a.TicketID != tk.ID || a.ActorUserID != nil || a.MessageID == nil || a.MessageID.String() != m["id"] {
				t.Fatalf("reply trigger: %+v", a)
			}
			if len(e.Jobs(jobs.SendMessageArgs{}.Kind(), ws.ID)) != 0 {
				t.Fatal("customer reply queued an agent email")
			}
			for _, body := range []string{"", " \n\t", strings.Repeat("x", 10001)} {
				e.Do("POST", portalTickets+"/"+tk.ID.String()+"/messages", customer, map[string]any{"body": body}).Want(t, 422)
			}
		})
	}
}
