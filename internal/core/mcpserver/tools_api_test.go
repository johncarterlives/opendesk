package mcpserver

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/auth"
)

// A request that came in by phone is logged as the customer's own words: inbound, by the
// contact, nothing sent, on a new ticket and on an existing one.
func TestLogCustomerMessages(t *testing.T) {
	e := newEnv(t)
	s := e.session(e.APIKey(e.WS, auth.ScopeTicketsRead, auth.ScopeTicketsWrite))
	var created struct {
		ID     string `json:"id"`
		Number int64  `json:"number"`
	}
	call(t, s, "create_ticket", map[string]any{"email": "caller@example.com", "name": "Cal", "subject": "Phone: login broken",
		"body": "I can't log in since this morning.", "direction": "inbound"}, &created)
	var dir, author string
	e.Scalar(`SELECT direction FROM messages WHERE ticket_id = $1`, &dir, created.ID)
	e.Scalar(`SELECT author_type FROM messages WHERE ticket_id = $1`, &author, created.ID)
	if dir != "inbound" || author != "contact" {
		t.Fatalf("logged request stored as %s by %s", dir, author)
	}

	var msg struct {
		MessageID string `json:"message_id"`
		Direction string `json:"direction"`
	}
	call(t, s, "reply_to_ticket", map[string]any{"ticket": fmt.Sprintf("#%d", created.Number), "body": "Called again: still broken.",
		"direction": "inbound"}, &msg)
	e.Scalar(`SELECT direction FROM messages WHERE id = $1`, &dir, msg.MessageID)
	if msg.Direction != "inbound" || dir != "inbound" {
		t.Fatalf("second call: %+v stored %s", msg, dir)
	}
	var sent int
	e.Scalar(`SELECT count(*) FROM messages WHERE ticket_id = $1 AND direction = 'outbound'`, &sent, created.ID)
	if sent != 0 {
		t.Fatal("a logged message was sent")
	}

	// A customer's own words carry no cc and no note.
	res := call(t, s, "reply_to_ticket", map[string]any{"ticket": created.ID, "body": "x", "direction": "inbound", "cc": []string{"a@example.com"}}, nil)
	if !res.IsError {
		t.Fatalf("inbound with cc: %s", text(res))
	}
	res = call(t, s, "create_ticket", map[string]any{"email": "c2@example.com", "subject": "x", "body": "x", "kind": "note", "direction": "inbound"}, nil)
	if !res.IsError {
		t.Fatalf("inbound note: %s", text(res))
	}
}

// Files reach a message: uploaded inline or from a URL, then named in attachment_ids.
func TestAttachFiles(t *testing.T) {
	e := newEnv(t)
	tk := e.ticket("Quote", "Please send the quote.")
	s := e.session(e.APIKey(e.WS, auth.ScopeTicketsRead, auth.ScopeTicketsWrite))

	var inline struct {
		AttachmentID string `json:"attachment_id"`
		Filename     string `json:"filename"`
		SizeBytes    int64  `json:"size_bytes"`
	}
	call(t, s, "upload_attachment", map[string]any{"filename": "notes.txt",
		"content_base64": base64.StdEncoding.EncodeToString([]byte("call notes"))}, &inline)
	if inline.AttachmentID == "" || inline.Filename != "notes.txt" || inline.SizeBytes != 10 {
		t.Fatalf("inline upload: %+v", inline)
	}

	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.4 quote"))
	}))
	defer files.Close()
	var fetched struct {
		AttachmentID string `json:"attachment_id"`
		Filename     string `json:"filename"`
	}
	call(t, s, "upload_attachment", map[string]any{"url": files.URL + "/docs/quote-42.pdf"}, &fetched)
	if fetched.AttachmentID == "" || fetched.Filename != "quote-42.pdf" {
		t.Fatalf("url upload: %+v", fetched)
	}

	var note struct {
		MessageID string `json:"message_id"`
	}
	call(t, s, "add_note", map[string]any{"ticket": tk.ID.String(), "body": "Quote attached.",
		"attachment_ids": []string{inline.AttachmentID, fetched.AttachmentID}}, &note)
	var n int
	e.Scalar(`SELECT count(*) FROM attachments WHERE message_id = $1`, &n, note.MessageID)
	if n != 2 {
		t.Fatalf("attachments on the note: %d", n)
	}

	// Neither both sources nor none, and executables are refused by the upload route.
	if res := call(t, s, "upload_attachment", map[string]any{"filename": "a.txt"}, nil); !res.IsError {
		t.Fatal("upload without content")
	}
	res := call(t, s, "upload_attachment", map[string]any{"filename": "run.exe",
		"content_base64": base64.StdEncoding.EncodeToString([]byte("MZ\x90\x00binary"))}, nil)
	if !res.IsError {
		t.Fatalf("executable uploaded: %s", text(res))
	}
}

// The API bridge reaches documented routes as the key, never past its scopes, and never
// the routes held back (account, credentials, uploads).
func TestAPIBridge(t *testing.T) {
	e := newEnv(t)
	tk := e.ticket("Bridge", "Hello")
	s := e.session(e.APIKey(e.WS, auth.ScopeTicketsRead, auth.ScopeTicketsWrite, auth.ScopeContactsRead))

	var found struct {
		Operations []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"operations"`
	}
	call(t, s, "find_api", map[string]any{"query": "ticket tags"}, &found)
	if len(found.Operations) == 0 {
		t.Fatal("find_api found nothing")
	}
	var areas struct {
		Areas []struct {
			Area string `json:"area"`
		} `json:"areas"`
	}
	call(t, s, "find_api", map[string]any{}, &areas)
	if len(areas.Areas) == 0 {
		t.Fatal("no areas")
	}

	var desc struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Body   any    `json:"body"`
	}
	call(t, s, "describe_api", map[string]any{"method": "PATCH", "path": "/v1/tickets/" + tk.ID.String()}, &desc)
	if desc.Path != "/v1/tickets/{id}" || desc.Body == nil {
		t.Fatalf("describe_api: %+v", desc)
	}

	// A read by ticket number, and a write.
	var got struct {
		ID string `json:"id"`
	}
	call(t, s, "api_read", map[string]any{"path": fmt.Sprintf("/v1/tickets/#%d", tk.Number)}, &got)
	if got.ID != tk.ID.String() {
		t.Fatalf("api_read: %+v", got)
	}
	var patched struct {
		Priority string `json:"priority"`
	}
	call(t, s, "api_write", map[string]any{"method": "PATCH", "path": "tickets/" + tk.ID.String(), "body": map[string]any{"priority": "urgent"}}, &patched)
	if patched.Priority != "urgent" {
		t.Fatalf("api_write: %+v", patched)
	}

	refused := func(name string, args map[string]any, want string) {
		t.Helper()
		res := call(t, s, name, args, nil)
		if !res.IsError || !strings.Contains(text(res), want) {
			t.Fatalf("%s %v: %s", name, args, text(res))
		}
	}
	// The key's scopes still apply: no contacts:write.
	refused("api_write", map[string]any{"method": "POST", "path": "/v1/contacts", "body": map[string]any{"name": "X"}}, "not allowed")
	// Held-back routes.
	refused("api_write", map[string]any{"method": "POST", "path": "/v1/api-keys", "body": map[string]any{"name": "x"}}, "not available")
	refused("api_read", map[string]any{"path": "/v1/me"}, "not available")
	refused("api_write", map[string]any{"method": "POST", "path": "/v1/attachments"}, "upload_attachment")
	refused("api_read", map[string]any{"path": "/v1/events"}, "not available")
	refused("api_write", map[string]any{"method": "POST", "path": "/v1/workspace/widget-secret/rotate"}, "rotating a secret")
	// Reads and writes keep to their tool.
	refused("api_write", map[string]any{"method": "DELETE", "path": "/v1/tickets/" + tk.ID.String() + "/nothing"}, "no documented route")
	refused("api_read", map[string]any{"path": "/v1/tickets/" + tk.ID.String() + "/../../me"}, "path must be")
	refused("api_read", map[string]any{"path": "/v1/tickets?status=open"}, "path must be")
	refused("describe_api", map[string]any{"method": "GET", "path": "/v1/nowhere"}, "no documented route")

	// A read-only key is not offered api_write.
	ro := toolNames(t, e.session(e.APIKey(e.WS, auth.ScopeTicketsRead)))
	if slices.Contains(ro, "api_write") || !slices.Contains(ro, "api_read") {
		t.Fatalf("read-only tools: %v", ro)
	}
}

func TestBridgeRedactsSecrets(t *testing.T) {
	out := apiResult([]byte(`{"name":"x","secret":"s3cr3t","webhook_url":"https://h/abc","nested":[{"client_secret":"abc","has_secret":true}],"next_cursor":"c"}`))
	raw, _ := json.Marshal(out)
	b := string(raw)
	if strings.Contains(b, "s3cr3t") || strings.Contains(b, "abc") || !strings.Contains(b, "has_secret") {
		t.Fatalf("redact: %s", b)
	}
}
