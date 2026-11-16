package tickets_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/mailsource"
)

const rawMail = "Received: from mx.example.com by mail.margin.app\r\nAuthentication-Results: mail.margin.app; spf=pass; dkim=pass\r\nFrom: Ada <ada@example.com>\r\nSubject: Where is my order?\r\n\r\nHello, where is it?\r\n"

func TestMessageSource(t *testing.T) {
	e, ws := newEnv(t)
	tk := createTicket(t, e, ws, map[string]any{"channel": "api", "kind": "note"})
	msg := inbound(t, e, ws, tk.ID, "Hello, where is it?")
	key := "workspaces/" + ws.ID.String() + "/inbound/source-test.eml"
	if err := e.D.Storage.Put(e.Ctx, key, strings.NewReader(rawMail), int64(len(rawMail)), "message/rfc822"); err != nil {
		t.Fatal(err)
	}
	var mailbox, ie uuid.UUID
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `INSERT INTO mailboxes (workspace_id, name, email, inbound_kind, forwarding_token, outbound_kind, brand_id)
		VALUES ($1, 'Support', $3, 'forwarding', $4, 'system', $2) RETURNING id`, ws.ID, ws.BrandID,
		"src-"+ws.ID.String()[:8]+"@example.com", "fw-src-"+ws.ID.String()).Scan(&mailbox); err != nil {
		t.Fatal(err)
	}
	if err := e.D.DB.Pool.QueryRow(e.Ctx, `INSERT INTO inbound_emails (workspace_id, mailbox_id, message_id_hdr, raw_storage_key) VALUES ($1, $2, '<s@x>', $3) RETURNING id`,
		ws.ID, mailbox, key).Scan(&ie); err != nil {
		t.Fatal(err)
	}
	e.Exec(`UPDATE messages SET inbound_email_id = $2, subject = 'Where is my order?' WHERE id = $1`, msg.ID, ie)
	path := "/v1/messages/" + msg.ID.String() + "/source"

	// An agent reads it; a viewer and a message that did not arrive by email cannot.
	var got mailsource.MailSource
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 200).JSON(t, &got)
	if got.Source != rawMail || got.SizeBytes != len(rawMail) || got.Truncated {
		t.Fatalf("source = %+v", got)
	}
	e.Do("GET", path, ws.Viewer.As(ws), nil).Want(t, 403)
	other := inbound(t, e, ws, tk.ID, "typed in the app")
	e.Do("GET", "/v1/messages/"+other.ID.String()+"/source", ws.Agent.As(ws), nil).Want(t, 404)
	e.Do("GET", "/v1/messages/"+uuid.NewString()+"/source", ws.Agent.As(ws), nil).Want(t, 404)
	otherWS := e.NewWorkspace()
	e.Do("GET", path, otherWS.Admin.As(otherWS), nil).Want(t, 404)

	// The download saves it as a file and never renders it.
	r := e.Do("GET", path+".eml", ws.Agent.As(ws), nil).Want(t, 200)
	if string(r.Body) != rawMail {
		t.Fatalf("download = %q", r.Body)
	}
	for k, want := range map[string]string{"Content-Type": "message/rfc822", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"} {
		if r.Header.Get(k) != want {
			t.Errorf("%s = %q", k, r.Header.Get(k))
		}
	}
	if cd := r.Header.Get("Content-Disposition"); cd != `attachment; filename="Where-is-my-order.eml"` {
		t.Fatalf("disposition %q", cd)
	}
	e.Do("GET", path+".eml", ws.Viewer.As(ws), nil).Want(t, 403)

	// A deleted message's source is the admins' only, and purging it removes the source.
	e.Do("DELETE", "/v1/tickets/"+tk.ID.String()+"/messages/"+msg.ID.String(), ws.Admin.As(ws), nil).Want(t, 204)
	e.Do("GET", path, ws.Agent.As(ws), nil).Want(t, 404)
	e.Do("GET", path, ws.Admin.As(ws), nil).Want(t, 200)
	e.Do("POST", "/v1/tickets/"+tk.ID.String()+"/messages/"+msg.ID.String()+"/purge", ws.Admin.As(ws), nil).Want(t, 200)
	e.Do("GET", path, ws.Admin.As(ws), nil).Want(t, 404)
}

func TestMailSourceView(t *testing.T) {
	big := strings.Repeat("X-Filler: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n", 30000)
	v := mailsource.View([]byte(big))
	if !v.Truncated || v.SizeBytes != len(big) || len(v.Source) > mailsource.ViewBytes || !strings.HasSuffix(v.Source, "\n") {
		t.Fatalf("truncated view: truncated=%v size=%d len=%d", v.Truncated, v.SizeBytes, len(v.Source))
	}
	// Read keeps only the shown part in memory and still counts the whole message.
	if r, err := mailsource.Read(strings.NewReader(big)); err != nil || r != v {
		t.Fatalf("Read = %+v, %v; want %+v", r.SizeBytes, err, v.SizeBytes)
	}
	if _, err := mailsource.Read(strings.NewReader(strings.Repeat("a", mailsource.MaxBytes+1))); err == nil {
		t.Fatal("a source over the cap was read")
	}
	if got := mailsource.View([]byte("Subject: \xff\xfe bad\r\n")).Source; !strings.Contains(got, "�") {
		t.Fatalf("invalid bytes were not replaced: %q", got)
	}
	for in, want := range map[string]string{"Re: Where's my order? / now": "Re-Where-s-my-order-now.eml", "": "message.eml", "../../etc/passwd": "etc-passwd.eml", "ä ö ü": "message.eml"} {
		if got := mailsource.Filename(in); got != want {
			t.Errorf("Filename(%q) = %q, want %q", in, got, want)
		}
	}
	if n := len(mailsource.Filename(strings.Repeat("a", 200))); n != 64 {
		t.Errorf("long name is %d characters", n)
	}
}
