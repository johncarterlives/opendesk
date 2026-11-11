package customerportal

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
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
	portalMessage(t, e, ws, own, "note", "internal note text")
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
	if len(m) != 6 || m["id"] != own.ID.String() || strings.Contains(string(r.Body), "private preview") || strings.Contains(string(r.Body), "internal") ||
		strings.Contains(string(r.Body), "last_note") {
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
	if len(rows) != 1 || rows[0]["id"] != first.ID.String() || len(rows[0]) != 5 || next == nil {
		t.Fatalf("first message page: %+v", rows)
	}
	rows, next = pageRows(t, e.Do("GET", path+"?limit=1&cursor="+url.QueryEscape(*next), customer, nil))
	if len(rows) != 1 || rows[0]["id"] != second.ID.String() || rows[0]["body_text"] != "Public second" || next != nil {
		t.Fatalf("public message page: %+v", rows)
	}
	r := e.Do("GET", path, customer, nil).Want(t, 200)
	for _, hidden := range []string{"Private", "Failed sender", "Deleted reply", "Purged reply", "Retracted marker", "body_html", "author_user_id", "from_email", "storage_key", "uploaded_by", "thread_id"} {
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
			if len(m) != 5 || m["body_text"] != text || m["direction"] != "inbound" {
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

// With Tickets off the portal answers feature_disabled for sign-in and requests, and keeps
// its brand readable.
func TestTicketsOffRefusesPortal(t *testing.T) {
	e, ws, cid, access := ticketSession(t)
	ticket := portalTicket(t, e, ws, cid, "open")
	e.SetSettings(ws, map[string]any{"tickets_enabled": false})

	var out struct{ Code, Product string }
	e.Do("GET", portalTickets, access, nil).Want(t, 403).JSON(t, &out)
	if out.Code != "feature_disabled" || out.Product != "tickets" {
		t.Fatalf("%+v", out)
	}
	e.Do("GET", portalTickets+"/"+ticket.ID.String(), access, nil).Want(t, 403)
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, map[string]any{"email": "x@example.com", "password": password}).Want(t, 403)
	e.Do("GET", base(ws)+"/config", hdtest.Auth{}, nil).Want(t, 200)

	e.SetSettings(ws, map[string]any{"tickets_enabled": true})
	e.Do("GET", portalTickets, access, nil).Want(t, 200)
}

func TestPortalCreateTicket(t *testing.T) {
	e, ws, cid, customer := ticketSession(t)
	var out map[string]any
	e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "  Order   never   arrived ", "body": "Hello,\nmy <b>order</b> is late."}).Want(t, 201).JSON(t, &out)
	id, _ := out["id"].(string)
	if out["subject"] != "Order never arrived" || out["status"] != domain.StatusOpen || id == "" {
		t.Fatalf("created %v", out)
	}
	// Only the customer's own projection comes back.
	for _, hidden := range []string{"priority", "assignee", "team_id", "tags", "custom", "channel"} {
		if _, ok := out[hidden]; ok {
			t.Fatalf("portal ticket exposes %s", hidden)
		}
	}

	// It is the customer's ticket, on the portal channel and brand, with their words as the first message.
	var channel, contact, brand string
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT channel, contact_id::text, brand_id::text FROM tickets WHERE id=$1`, id).Scan(&channel, &contact, &brand); err != nil {
		t.Fatal(err)
	}
	if channel != domain.ChannelPortal || contact != cid.String() || brand != ws.BrandID.String() {
		t.Fatalf("channel=%s contact=%s brand=%s", channel, contact, brand)
	}
	var text, html, kind, direction, author string
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT body_text, body_html, kind, direction, author_type FROM messages WHERE ticket_id=$1`, id).Scan(&text, &html, &kind, &direction, &author); err != nil {
		t.Fatal(err)
	}
	if text != "Hello,\nmy <b>order</b> is late." || kind != "reply" || direction != "inbound" || author != "contact" {
		t.Fatalf("message %q %s %s %s", text, kind, direction, author)
	}
	if strings.Contains(html, "<b>") {
		t.Fatalf("the customer's markup reached the stored HTML: %s", html)
	}
	// Automations see a new ticket.
	if n := len(e.Jobs(jobs.TicketTriggerArgs{}.Kind(), ws.ID)); n != 1 {
		t.Fatalf("ticket_created triggers: %d", n)
	}
	// It is in the customer's list, and they can read it back.
	rows, _ := pageRows(t, e.Do("GET", portalTickets, customer, nil))
	if len(rows) != 1 || rows[0]["id"] != id {
		t.Fatalf("list %v", rows)
	}
	msgs, _ := pageRows(t, e.Do("GET", portalTickets+"/"+id+"/messages", customer, nil))
	if len(msgs) != 1 || msgs[0]["direction"] != "inbound" {
		t.Fatalf("messages %v", msgs)
	}

	// Routing applies as for any channel: a rule on the portal channel puts it in a team.
	team := ids.New()
	e.Exec(`INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'Portal team')`, team, ws.ID)
	e.Exec(`INSERT INTO routing_rules (workspace_id, name, conditions, team_id, position) VALUES ($1, 'Portal', '[{"field":"channel","op":"equals","value":"portal"}]', $2, 0)`, ws.ID, team)
	e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Second", "body": "Again"}).Want(t, 201).JSON(t, &out)
	var routed *string
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT team_id::text FROM tickets WHERE id=$1`, out["id"]).Scan(&routed); err != nil || routed == nil || *routed != team.String() {
		t.Fatalf("routed to %v: %v", routed, err)
	}
}

func TestPortalCreateTicketRefusals(t *testing.T) {
	e, ws, cid, customer := ticketSession(t)
	post := func(a hdtest.Auth, b map[string]any) *hdtest.Resp { return e.Do("POST", portalTickets, a, b) }
	ok := map[string]any{"workspace_slug": ws.Slug, "subject": "Help", "body": "Please"}
	tickets := func() int {
		var n int
		e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &n, ws.ID)
		return n
	}

	// Signed out, as a member, or with a staff token: no ticket.
	post(hdtest.Auth{}, ok).Want(t, 401)
	post(ws.Agent.As(ws), ok).Want(t, 401)
	// A blank or oversized subject or message, and a brand that is not this workspace's help center.
	post(customer, map[string]any{"workspace_slug": ws.Slug, "subject": "   ", "body": "x"}).Want(t, 422)
	post(customer, map[string]any{"workspace_slug": ws.Slug, "subject": "x", "body": "   "}).Want(t, 422)
	post(customer, map[string]any{"workspace_slug": ws.Slug, "subject": strings.Repeat("s", 201), "body": "x"}).Want(t, 422)
	post(customer, map[string]any{"workspace_slug": ws.Slug, "subject": "x", "body": strings.Repeat("b", 10001)}).Want(t, 422)
	post(customer, map[string]any{"workspace_slug": "no-such-help-center", "subject": "x", "body": "x"}).Want(t, 404)
	other := e.NewWorkspace()
	e.Exec(`UPDATE brands SET help_center_enabled=true WHERE id=$1`, other.BrandID)
	post(customer, map[string]any{"workspace_slug": other.Slug, "subject": "x", "body": "x"}).Want(t, 404)
	if n := tickets(); n != 0 {
		t.Fatalf("a refused request left %d tickets", n)
	}

	// The workspace and the customer come from the session: the body has no place for either.
	post(customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Mine", "body": "x", "contact_id": ids.New().String()}).Want(t, 422)
	post(customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Mine", "body": "x", "workspace_id": other.ID.String()}).Want(t, 422)
	post(customer, ok).Want(t, 201)
	var contact string
	e.Scalar(`SELECT contact_id::text FROM tickets WHERE workspace_id=$1`, &contact, ws.ID)
	var elsewhere int
	e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &elsewhere, other.ID)
	if contact != cid.String() || elsewhere != 0 {
		t.Fatalf("ticket for contact %s, %d in another workspace", contact, elsewhere)
	}

	// A blocked customer starts nothing.
	e.Exec(`UPDATE contacts SET blocked=true WHERE id=$1`, cid)
	post(customer, ok).Want(t, 401)
	e.Exec(`UPDATE contacts SET blocked=false WHERE id=$1`, cid)
}

func TestPortalCreateTicketIsRateLimited(t *testing.T) {
	e, ws, _, customer := ticketSession(t)
	for i := range newRequestsPerHour {
		e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Request", "body": "n" + strings.Repeat("x", i)}).Want(t, 201)
	}
	e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "One too many", "body": "x"}).Want(t, 429)
	var n int
	e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &n, ws.ID)
	if n != newRequestsPerHour {
		t.Fatalf("%d tickets", n)
	}
}

// The workspace's customers together start a bounded number of requests an hour; one customer's
// own limit is counted first, so a refused customer does not use up the workspace's.
func TestPortalCreateTicketWorkspaceLimit(t *testing.T) {
	e, ws, _, first := ticketSession(t)
	was := workspaceRequestsPerHour
	workspaceRequestsPerHour = 3
	t.Cleanup(func() { workspaceRequestsPerHour = was })
	// A second customer of the same workspace, signed in with a password of their own.
	other := ids.New()
	email := "second-" + other.String() + "@example.com"
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,$3,'Second')`, other, ws.ID, email)
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`INSERT INTO customer_credentials(workspace_id,contact_id,email,password_hash) VALUES($1,$2,$3,$4)`, ws.ID, other, email, hash)
	access, _ := signIn(t, e, ws, email)
	second := hdtest.Auth{Bearer: access}
	// Another workspace's portal keeps its own count.
	elsewhereWS, elsewhereCID, elsewhere := otherPortalCustomer(t, e)

	request := func(a hdtest.Auth, slug string) *hdtest.Resp {
		return e.Do("POST", portalTickets, a, map[string]any{"workspace_slug": slug, "subject": "Help", "body": "Please"})
	}
	request(first, ws.Slug).Want(t, 201)
	request(second, ws.Slug).Want(t, 201)
	request(first, ws.Slug).Want(t, 201)
	var out struct{ Code string }
	request(second, ws.Slug).Want(t, 429).JSON(t, &out)
	if out.Code != "portal_busy" {
		t.Fatalf("code %q", out.Code)
	}
	request(elsewhere, elsewhereWS.Slug).Want(t, 201)
	var n int
	e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &n, ws.ID)
	if n != 3 {
		t.Fatalf("%d tickets", n)
	}
	var contact string
	e.Scalar(`SELECT contact_id::text FROM tickets WHERE workspace_id=$1`, &contact, elsewhereWS.ID)
	if contact != elsewhereCID.String() {
		t.Fatalf("other workspace ticket for %s", contact)
	}
}

// otherPortalCustomer signs in a customer of a second workspace's portal on the same instance.
func otherPortalCustomer(t *testing.T, e *hdtest.Env) (hdtest.WS, uuid.UUID, hdtest.Auth) {
	t.Helper()
	ws := e.NewWorkspace()
	e.Exec(`UPDATE brands SET help_center_enabled=true WHERE id=$1`, ws.BrandID)
	cid := ids.New()
	email := "elsewhere-" + cid.String() + "@example.com"
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,$3,'Elsewhere')`, cid, ws.ID, email)
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`INSERT INTO customer_credentials(workspace_id,contact_id,email,password_hash) VALUES($1,$2,$3,$4)`, ws.ID, cid, email, hash)
	access, _ := signIn(t, e, ws, email)
	return ws, cid, hdtest.Auth{Bearer: access}
}

// A brand whose portal is off (its help center turned off) takes no new request, and its
// signed-in customers' requests start again once it is back on. A suspended workspace takes none.
func TestPortalOffRefusesNewRequest(t *testing.T) {
	e, ws, _, customer := ticketSession(t)
	ok := map[string]any{"workspace_slug": ws.Slug, "subject": "Help", "body": "Please"}
	e.Exec(`UPDATE brands SET help_center_enabled=false WHERE id=$1`, ws.BrandID)
	e.Do("POST", portalTickets, customer, ok).Want(t, 404)
	var n int
	e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &n, ws.ID)
	if n != 0 {
		t.Fatalf("a portal that is off opened %d tickets", n)
	}
	e.Exec(`UPDATE brands SET help_center_enabled=true WHERE id=$1`, ws.BrandID)
	e.Do("POST", portalTickets, customer, ok).Want(t, 201)
	e.Exec(`UPDATE workspaces SET suspended_at=now() WHERE id=$1`, ws.ID)
	e.Do("POST", portalTickets, customer, ok).Want(t, 401)
	e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &n, ws.ID)
	if n != 1 {
		t.Fatalf("%d tickets after the workspace was suspended", n)
	}
}

const portalUploads = "/v1/customer/portal/attachments"

func TestPortalRequestWithFiles(t *testing.T) {
	e, ws, cid, customer := ticketSession(t)
	var shot domain.Attachment
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	e.Upload(portalUploads, customer, "screenshot.png", png).Want(t, 201).JSON(t, &shot)
	if shot.Filename != "screenshot.png" || shot.ContentType != "image/png" || shot.SizeBytes != int64(len(png)) || shot.URL == "" {
		t.Fatalf("upload %+v", shot)
	}
	var notes domain.Attachment
	e.Upload(portalUploads, customer, "notes.txt", []byte("what I did")).Want(t, 201).JSON(t, &notes)
	var uploader string
	e.Scalar(`SELECT uploaded_by_contact_id::text FROM attachments WHERE id=$1`, &uploader, shot.ID)
	if uploader != cid.String() {
		t.Fatalf("uploaded by %s", uploader)
	}

	// Sent with the request, the files belong to the first message and the customer reads them back.
	var out map[string]any
	e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Broken page", "body": "See the screenshot",
		"attachment_ids": []string{shot.ID.String(), notes.ID.String()}}).Want(t, 201).JSON(t, &out)
	id := out["id"].(string)
	msgs, _ := pageRows(t, e.Do("GET", portalTickets+"/"+id+"/messages", customer, nil))
	files, _ := msgs[0]["attachments"].([]any)
	if len(msgs) != 1 || len(files) != 2 {
		t.Fatalf("messages %v", msgs)
	}
	first := files[0].(map[string]any)
	u, err := url.Parse(first["url"].(string))
	if err != nil || first["filename"] != "screenshot.png" || first["content_type"] != "image/png" ||
		!domain.VerifyAttachmentSig(shot.ID, u.Query().Get("exp"), u.Query().Get("sig"), false) {
		t.Fatalf("attachment %v", first)
	}
	// A reply has none, and says so with an empty list, not null.
	var reply map[string]any
	e.Do("POST", portalTickets+"/"+id+"/messages", customer, map[string]any{"body": "Thanks"}).Want(t, 201).JSON(t, &reply)
	if a, ok := reply["attachments"].([]any); !ok || len(a) != 0 {
		t.Fatalf("reply attachments %v", reply["attachments"])
	}
	// A request without files still lists an empty array.
	e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Plain", "body": "x"}).Want(t, 201).JSON(t, &out)
	msgs, _ = pageRows(t, e.Do("GET", portalTickets+"/"+out["id"].(string)+"/messages", customer, nil))
	if a, ok := msgs[0]["attachments"].([]any); !ok || len(a) != 0 {
		t.Fatalf("plain attachments %v", msgs[0]["attachments"])
	}
	// A file belongs to one message: the same id cannot go on a second request.
	e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "Again", "body": "x", "attachment_ids": []string{shot.ID.String()}}).Want(t, 422)
}

func TestPortalUploadRefusals(t *testing.T) {
	e, ws, _, customer := ticketSession(t)
	// Signed out, or a member's token.
	e.Upload(portalUploads, hdtest.Auth{}, "a.txt", []byte("x")).Want(t, 401)
	e.Upload(portalUploads, ws.Agent.As(ws), "a.txt", []byte("x")).Want(t, 401)
	// Programs and scripts, an empty file and one over 10 MB.
	e.Upload(portalUploads, customer, "run.exe", []byte("MZ\x90\x00 program")).Want(t, 422)
	e.Upload(portalUploads, customer, "setup.sh", []byte("#!/bin/sh\nrm -rf /\n")).Want(t, 422)
	e.Upload(portalUploads, customer, "empty.txt", nil).Want(t, 422)
	e.Upload(portalUploads, customer, "big.txt", bytes.Repeat([]byte("a"), 10<<20+1)).Want(t, 413)
	var n int
	e.Scalar(`SELECT count(*) FROM attachments WHERE workspace_id=$1`, &n, ws.ID)
	if n != 0 {
		t.Fatalf("a refused upload left %d files", n)
	}

	// Only the uploader may attach a file: another customer's, a member's, and one that does not exist.
	var mine domain.Attachment
	e.Upload(portalUploads, customer, "mine.txt", []byte("mine")).Want(t, 201).JSON(t, &mine)
	theirs, theirFile := ids.New(), ids.New()
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, 'Other', 'other@example.com')`, theirs, ws.ID)
	e.Exec(`INSERT INTO attachments (id, workspace_id, filename, content_type, size_bytes, storage_key, uploaded_by_contact_id)
		VALUES ($1, $2, 'theirs.txt', 'text/plain', 5, 'workspaces/x/attachments/theirs', $3)`, theirFile, ws.ID, theirs)
	otherID := theirFile
	post := func(att ...string) *hdtest.Resp {
		return e.Do("POST", portalTickets, customer, map[string]any{"workspace_slug": ws.Slug, "subject": "x", "body": "x", "attachment_ids": att})
	}
	post(ids.New().String()).Want(t, 422)
	post(otherID.String()).Want(t, 422)
	// Over five files, and a malformed id.
	six := make([]string, 6)
	for i := range six {
		six[i] = mine.ID.String()
	}
	post(six...).Want(t, 422)
	post("not-an-id").Want(t, 422)
	e.Scalar(`SELECT count(*) FROM tickets WHERE workspace_id=$1`, &n, ws.ID)
	if n != 0 {
		t.Fatalf("refused requests left %d tickets", n)
	}
	// The same upload goes through once the request is valid.
	post(mine.ID.String()).Want(t, 201)
}
