package email

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/storage"
)

// sentCopyBox is an IMAP mailbox that sends through opendesk, on the in-memory server
// with a Sent folder.
func sentCopyBox(t *testing.T, w *world) (*imapmemserver.User, *mailboxRow) {
	t.Helper()
	u, port := imapServer(t, w)
	if err := u.Create("Sent", nil); err != nil {
		t.Fatal(err)
	}
	m := w.mailbox(InboundIMAP, OutboundSystem, func(m *mailboxRow, c *credentials) {
		m.Email = "agent@acme.test"
		m.Config = MailboxConfig{IMAPHost: "127.0.0.1", IMAPPort: port, IMAPTLS: TLSImplicit, IMAPUsername: "agent@acme.test"}
		c.Password = "imap-pass-1"
	})
	return u, m
}

func folderCounts(t *testing.T, u *imapmemserver.User, name string) (all, unseen uint32) {
	t.Helper()
	st, err := u.Status(name, &imap.StatusOptions{NumMessages: true, NumUnseen: true})
	if err != nil {
		t.Fatal(err)
	}
	return *st.NumMessages, *st.NumUnseen
}

// queuedSentCopy is the sent-copy job keepSentCopy queued last, as the worker gets it.
func queuedSentCopy(t *testing.T, w *world, attempt int) *river.Job[jobs.SentCopyArgs] {
	t.Helper()
	var raw []byte
	if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT args FROM river_job WHERE kind = 'email.sent_copy' AND args->>'workspace_id' = $1
		ORDER BY id DESC LIMIT 1`, w.wid.String()).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var a jobs.SentCopyArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	return &river.Job[jobs.SentCopyArgs]{JobRow: &rivertype.JobRow{Attempt: attempt, MaxAttempts: sentCopyAttempts}, Args: a}
}

// sentCopyDate is the internal date of the first message in the mailbox's Sent folder.
func sentCopyDate(t *testing.T, w *world, m *mailboxRow) time.Time {
	t.Helper()
	sess, err := w.s.dialIMAP(w.ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	if _, err := sess.c.Select("Sent", &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
		t.Fatal(err)
	}
	msgs, err := sess.c.Fetch(imap.SeqSetNum(1), &imap.FetchOptions{InternalDate: true}).Collect()
	if err != nil || len(msgs) != 1 {
		t.Fatalf("fetch: %v %d", err, len(msgs))
	}
	return msgs[0].InternalDate
}

func stored(w *world, key string) bool {
	rc, err := w.d.Storage.Get(w.ctx, key)
	if err == nil {
		_ = rc.Close()
	}
	return !errors.Is(err, storage.ErrNotFound)
}

// TestSentCopy: an email the mailbox sent is kept in its sent folder, marked read, and the
// stored message goes once it is there.
func TestSentCopy(t *testing.T) {
	w := newWorld(t)
	u, m := sentCopyBox(t, w)
	worker := &sentCopyWorker{s: w.s}
	raw := []byte(strings.ReplaceAll(testMail("agent@acme.test", "Re: your order"), "\n", "\r\n"))

	// Off by default: nothing is queued.
	w.s.keepSentCopy(w.ctx, m, raw)
	if w.count(`SELECT count(*) FROM river_job WHERE kind = 'email.sent_copy' AND args->>'workspace_id' = $1`, w.wid.String()) != 0 {
		t.Fatal("queued without a sent folder")
	}

	mustExec(t, w.d, `UPDATE mailboxes SET imap_sent_folder = 'Sent' WHERE id = $1`, m.ID)
	m, _ = loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID)
	w.s.keepSentCopy(w.ctx, m, raw)
	job := queuedSentCopy(t, w, 1)
	if !stored(w, job.Args.StorageKey) || !strings.HasPrefix(job.Args.StorageKey, "workspaces/"+w.wid.String()+"/") {
		t.Fatalf("message not stored under the workspace: %s", job.Args.StorageKey)
	}
	if time.Since(job.Args.SentAt) > time.Minute {
		t.Fatalf("sent_at not recorded: %v", job.Args.SentAt)
	}
	// The copy is dated when the email went out, not when the job ran.
	sentAt := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	job.Args.SentAt = sentAt
	if err := worker.Work(w.ctx, job); err != nil {
		t.Fatal(err)
	}
	if all, unseen := folderCounts(t, u, "Sent"); all != 1 || unseen != 0 {
		t.Fatalf("Sent: %d messages, %d unread", all, unseen)
	}
	if got := sentCopyDate(t, w, m); !got.Equal(sentAt) {
		t.Fatalf("copy dated %v, want %v", got, sentAt)
	}
	if stored(w, job.Args.StorageKey) {
		t.Fatal("stored message kept after the copy")
	}

	// A folder the server does not have: retried, then given up and cleaned up.
	mustExec(t, w.d, `UPDATE mailboxes SET imap_sent_folder = 'Gone' WHERE id = $1`, m.ID)
	m, _ = loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID)
	w.s.keepSentCopy(w.ctx, m, raw)
	job = queuedSentCopy(t, w, 1)
	if err := worker.Work(w.ctx, job); err == nil || !stored(w, job.Args.StorageKey) {
		t.Fatalf("first failure: %v, stored %v", err, stored(w, job.Args.StorageKey))
	}
	job.Attempt = sentCopyAttempts
	if err := worker.Work(w.ctx, job); err != nil || stored(w, job.Args.StorageKey) {
		t.Fatalf("last attempt: %v, stored %v", err, stored(w, job.Args.StorageKey))
	}

	// Turned off before the job ran: nothing is stored, and the message goes.
	mustExec(t, w.d, `UPDATE mailboxes SET imap_sent_folder = 'Sent' WHERE id = $1`, m.ID)
	m, _ = loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID)
	w.s.keepSentCopy(w.ctx, m, raw)
	job = queuedSentCopy(t, w, 1)
	mustExec(t, w.d, `UPDATE mailboxes SET imap_sent_folder = '' WHERE id = $1`, m.ID)
	if err := worker.Work(w.ctx, job); err != nil || stored(w, job.Args.StorageKey) {
		t.Fatalf("turned off: %v, stored %v", err, stored(w, job.Args.StorageKey))
	}
	if all, _ := folderCounts(t, u, "Sent"); all != 1 {
		t.Fatalf("Sent after turning off: %d messages", all)
	}
}

// TestSentFolderAPI: who may keep sent copies, and the rules a folder name keeps.
func TestSentFolderAPI(t *testing.T) {
	w := newWorld(t)
	_, m := sentCopyBox(t, w)
	srv := w.api(w.admin)
	url := srv.URL + "/v1/mailboxes/" + m.ID.String()

	var out Mailbox
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_sent_folder": " Sent "}, &out); code != http.StatusOK || out.IMAPSentFolder != "Sent" {
		t.Fatalf("set: %d %q", code, out.IMAPSentFolder)
	}
	if w.count(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'mailbox.updated' AND data->>'imap_sent_folder' = 'Sent'`, w.wid) != 1 {
		t.Fatal("not audited")
	}
	for name, v := range map[string]string{"inbox": "inbox", "control": "Sent\nBox", "long": strings.Repeat("x", 256)} {
		if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_sent_folder": v}, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: %d", name, code)
		}
	}
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_sent_folder": ""}, &out); code != http.StatusOK || out.IMAPSentFolder != "" {
		t.Fatalf("off: %d %q", code, out.IMAPSentFolder)
	}

	// A forwarding mailbox has no IMAP server to keep copies on.
	fwd := w.mailbox(InboundForwarding, OutboundSystem, nil)
	if code := doJSON(t, http.MethodPatch, srv.URL+"/v1/mailboxes/"+fwd.ID.String(), map[string]any{"imap_sent_folder": "Sent"}, nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("forwarding: %d", code)
	}
}

func TestNormalizeSentFolder(t *testing.T) {
	if v, err := normalizeSentFolder("  Sent Items "); err != nil || v != "Sent Items" {
		t.Fatalf("%q %v", v, err)
	}
	if v, err := normalizeSentFolder(" "); err != nil || v != "" {
		t.Fatalf("blank: %q %v", v, err)
	}
	if _, err := normalizeSentFolder("INBOX"); err == nil {
		t.Fatal("INBOX accepted")
	}
}

// TestSentCopyOnSend: a reply sent through opendesk queues the very email that went out,
// and a send that failed queues nothing.
func TestSentCopyOnSend(t *testing.T) {
	w := newWorld(t)
	u, m := sentCopyBox(t, w)
	mustExec(t, w.d, `UPDATE mailboxes SET imap_sent_folder = 'Sent' WHERE id = $1`, m.ID)
	var sent []byte
	fail := false
	w.s.rawSend = func(_ context.Context, _ string, _ []string, raw []byte) error {
		if fail {
			return errors.New("connection refused")
		}
		sent = raw
		return nil
	}
	tk, _ := firstTicket(t, w, m, customer())
	reply := func(body string) uuid.UUID {
		var mid uuid.UUID
		err := w.d.DB.Tx(w.ctx, func(tx pgxTx) error {
			msg, err := domain.AddMessage(w.ctx, tx, w.d.Jobs, domain.NewMessage{WorkspaceID: w.wid, TicketID: tk.ID, Kind: "reply",
				Direction: "outbound", AuthorType: "user", AuthorUserID: &w.uid, DeliveryStatus: "pending", BodyHTML: "<p>" + body + "</p>", BodyText: body})
			mid = msg.ID
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return mid
	}
	if err := w.s.sendMessage(w.ctx, w.wid, reply("On its way"), false); err != nil {
		t.Fatal(err)
	}
	job := queuedSentCopy(t, w, 1)
	rc, err := w.d.Storage.Get(w.ctx, job.Args.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	kept, _ := io.ReadAll(rc)
	_ = rc.Close()
	if len(sent) == 0 || !bytes.Equal(kept, sent) {
		t.Fatal("the stored copy is not the email that went out")
	}
	if err := (&sentCopyWorker{s: w.s}).Work(w.ctx, job); err != nil {
		t.Fatal(err)
	}
	if all, _ := folderCounts(t, u, "Sent"); all != 1 {
		t.Fatalf("Sent: %d messages", all)
	}

	fail = true
	before := w.count(`SELECT count(*) FROM river_job WHERE kind = 'email.sent_copy' AND args->>'workspace_id' = $1`, w.wid.String())
	_ = w.s.sendMessage(w.ctx, w.wid, reply("Not sent"), false)
	if w.count(`SELECT count(*) FROM river_job WHERE kind = 'email.sent_copy' AND args->>'workspace_id' = $1`, w.wid.String()) != before {
		t.Fatal("a failed send queued a copy")
	}
}
