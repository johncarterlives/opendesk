package email

import (
	"bytes"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
)

func appendTo(t *testing.T, u *imapmemserver.User, folder, raw string, at time.Time) {
	t.Helper()
	raw = strings.ReplaceAll(strings.ReplaceAll(raw, "\r\n", "\n"), "\n", "\r\n")
	if _, err := u.Append(folder, literal{bytes.NewReader([]byte(raw)), int64(len(raw))}, &imap.AppendOptions{Time: at}); err != nil {
		t.Fatal(err)
	}
}

// imapFolderBox is an IMAP mailbox on the in-memory server, with the folders
// Support/Billing and Archive beside INBOX.
func imapFolderBox(t *testing.T, w *world) (*imapmemserver.User, *mailboxRow) {
	t.Helper()
	u, port := imapServer(t, w)
	for _, f := range []string{"Support", "Support/Billing", "Archive"} {
		if err := u.Create(f, nil); err != nil {
			t.Fatal(err)
		}
	}
	m := w.mailbox(InboundIMAP, OutboundSystem, func(m *mailboxRow, c *credentials) {
		m.Email = "agent@acme.test"
		m.Config = MailboxConfig{IMAPHost: "127.0.0.1", IMAPPort: port, IMAPTLS: TLSImplicit, IMAPUsername: "agent@acme.test"}
		c.Password = "imap-pass-1"
	})
	return u, m
}

// TestIMAPSyncFolders: a mailbox reads every folder it chose, each from its own cursor, and
// a message filed in two of them becomes one inbound email.
func TestIMAPSyncFolders(t *testing.T) {
	w := newWorld(t)
	u, m := imapFolderBox(t, w)
	srv := w.api(w.admin)
	appendTo(t, u, "INBOX", testMail(customer(), "in the inbox"), time.Now())
	billing := testMail(customer(), "filed under billing")
	appendTo(t, u, "Support/Billing", billing, time.Now())
	appendTo(t, u, "INBOX", billing, time.Now()) // the same message in two folders
	appendTo(t, u, "Archive", testMail(customer(), "archived"), time.Now())

	if code := doJSON(t, http.MethodPatch, srv.URL+"/v1/mailboxes/"+m.ID.String(),
		map[string]any{"imap_folders": []string{"inbox", "Support/Billing"}}, nil); code != http.StatusOK {
		t.Fatalf("choose folders: %d", code)
	}
	inbound := func() int { return w.count(`SELECT count(*) FROM inbound_emails WHERE mailbox_id = $1`, m.ID) }
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if n := inbound(); n != 2 {
		t.Fatalf("first pass: %d inbound emails, want 2 (Archive not chosen, the copy deduped)", n)
	}
	m2, _ := loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID)
	if m2.Status != "active" || m2.LastUID != 2 || m2.UIDValidity == 0 {
		t.Fatalf("INBOX cursor: %s uid %d validity %d", m2.Status, m2.LastUID, m2.UIDValidity)
	}
	if w.count(`SELECT count(*) FROM mailbox_imap_folders WHERE mailbox_id = $1 AND name = 'Support/Billing' AND last_uid = 1 AND uid_validity > 0`, m.ID) != 1 {
		t.Fatal("Support/Billing cursor not stored")
	}

	// Only what is new in each folder on the next pass.
	appendTo(t, u, "Support/Billing", testMail(customer(), "second billing"), time.Now())
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if n := inbound(); n != 3 {
		t.Fatalf("second pass: %d inbound emails, want 3", n)
	}

	// A folder that is gone is skipped and named: the folders after it are still read and the
	// mailbox stays active, with no backoff.
	mustExec(t, w.d, `UPDATE mailboxes SET imap_folders = '{INBOX,Gone,Support/Billing}' WHERE id = $1`, m.ID)
	appendTo(t, u, "INBOX", testMail(customer(), "new in the inbox"), time.Now())
	appendTo(t, u, "Support/Billing", testMail(customer(), "third billing"), time.Now())
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	m2, _ = loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID)
	if m2.Status != "active" || !strings.Contains(m2.LastError, "the folder Gone") || m2.LastUID != 3 || inbound() != 5 ||
		w.count(`SELECT count(*) FROM mailboxes WHERE id = $1 AND sync_failures = 0 AND next_sync_at IS NULL`, m.ID) != 1 {
		t.Fatalf("missing folder: %s %q cursor %d inbound %d", m2.Status, m2.LastError, m2.LastUID, inbound())
	}
	// Once the folder opens again, the warning clears.
	if err := u.Create("Gone", nil); err != nil {
		t.Fatal(err)
	}
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if m2, _ = loadMailbox(w.ctx, w.d.DB.Pool, w.wid, m.ID); m2.Status != "active" || m2.LastError != "" {
		t.Fatalf("after the folder came back: %s %q", m2.Status, m2.LastError)
	}

	// A pass that races a folder's removal does not bring its cursor back.
	mustExec(t, w.d, `UPDATE mailboxes SET imap_folders = '{INBOX}' WHERE id = $1`, m.ID)
	mustExec(t, w.d, `DELETE FROM mailbox_imap_folders WHERE mailbox_id = $1`, m.ID)
	if err := w.s.saveFolderCursor(w.ctx, m2, "Support/Billing", folderCursor{7, 9}); err != nil {
		t.Fatal(err)
	}
	if w.count(`SELECT count(*) FROM mailbox_imap_folders WHERE mailbox_id = $1`, m.ID) != 0 {
		t.Fatal("cursor stored for a folder the mailbox no longer reads")
	}
}

// TestIMAPFoldersInboxDropped: unticking INBOX forgets its cursor, so ticking it again reads
// it as a new connection does, not everything that arrived in between.
func TestIMAPFoldersInboxDropped(t *testing.T) {
	w := newWorld(t)
	u, m := imapFolderBox(t, w)
	srv := w.api(w.admin)
	url := srv.URL + "/v1/mailboxes/" + m.ID.String()
	mustExec(t, w.d, `UPDATE mailboxes SET config = config || '{"sync_start":"new"}' WHERE id = $1`, m.ID)
	appendTo(t, u, "INBOX", testMail(customer(), "before"), time.Now())
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_folders": []string{"Archive"}}, nil); code != http.StatusOK {
		t.Fatalf("untick INBOX: %d", code)
	}
	if w.count(`SELECT count(*) FROM mailboxes WHERE id = $1 AND imap_uid_validity = 0 AND imap_last_uid = 0`, m.ID) != 1 {
		t.Fatal("INBOX cursor kept after unticking it")
	}
	appendTo(t, u, "INBOX", testMail(customer(), "while not read"), time.Now())
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if w.count(`SELECT count(*) FROM mailboxes WHERE id = $1 AND imap_uid_validity = 0`, m.ID) != 1 {
		t.Fatal("a pass without INBOX stored its cursor")
	}
	// Choosing folders again also clears an error and its backoff.
	mustExec(t, w.d, `UPDATE mailboxes SET status = 'error', last_error = 'x', sync_failures = 5, next_sync_at = now() + interval '1 hour' WHERE id = $1`, m.ID)
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_folders": []string{"Archive", "INBOX"}}, nil); code != http.StatusOK {
		t.Fatalf("tick INBOX again: %d", code)
	}
	if w.count(`SELECT count(*) FROM mailboxes WHERE id = $1 AND last_error = '' AND sync_failures = 0 AND next_sync_at IS NULL`, m.ID) != 1 {
		t.Fatal("backoff kept after the folders changed")
	}
	if err := w.s.syncMailbox(w.ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM inbound_emails WHERE mailbox_id = $1`, m.ID); n != 0 {
		t.Fatalf("%d inbound emails, want 0: INBOX read again as new with sync_start new", n)
	}
}

// TestMailboxIMAPFoldersAPI: choosing folders, the rules a list must keep, listing the
// server's folders, and the cursors a change forgets.
func TestMailboxIMAPFoldersAPI(t *testing.T) {
	w := newWorld(t)
	_, m := imapFolderBox(t, w)
	srv := w.api(w.admin)
	url := srv.URL + "/v1/mailboxes/" + m.ID.String()

	var list struct {
		Folders  []IMAPFolder `json:"folders"`
		Selected []string     `json:"selected"`
	}
	if code := doJSON(t, http.MethodGet, url+"/imap-folders", nil, &list); code != http.StatusOK {
		t.Fatalf("list: %d", code)
	}
	var names []string
	for _, f := range list.Folders {
		names = append(names, f.Name)
	}
	if !slices.Equal(names, []string{"INBOX", "Archive", "Support", "Support/Billing"}) || !slices.Equal(list.Selected, []string{"INBOX"}) {
		t.Fatalf("folders %v selected %v", names, list.Selected)
	}

	var out Mailbox
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_folders": []string{" Support/Billing ", "inbox", "INBOX", ""}}, &out); code != http.StatusOK {
		t.Fatalf("patch: %d", code)
	}
	if !slices.Equal(out.IMAPFolders, []string{"INBOX", "Support/Billing"}) {
		t.Fatalf("stored %v", out.IMAPFolders)
	}
	if w.count(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'mailbox.updated' AND data->'changes' ? 'imap_folders' AND data->'imap_folders' IS NOT NULL`, w.wid) != 1 {
		t.Fatal("folder change not audited")
	}
	// INBOX alone is the default, stored empty.
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_folders": []string{"Inbox"}}, &out); code != http.StatusOK || len(out.IMAPFolders) != 0 {
		t.Fatalf("inbox alone: %d %v", code, out.IMAPFolders)
	}
	tooMany := make([]string, 11)
	for i := range tooMany {
		tooMany[i] = "F" + string(rune('a'+i))
	}
	for name, folders := range map[string][]string{"eleven": tooMany, "control": {"Bad\nName"}, "long": {strings.Repeat("x", 256)}} {
		if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_folders": folders}, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: %d", name, code)
		}
	}

	// Dropping a folder forgets its cursor; another server forgets them all.
	mustExec(t, w.d, `UPDATE mailboxes SET imap_folders = '{INBOX,Archive,Support}' WHERE id = $1`, m.ID)
	mustExec(t, w.d, `INSERT INTO mailbox_imap_folders (mailbox_id, workspace_id, name, uid_validity, last_uid)
		VALUES ($1, $2, 'Archive', 7, 3), ($1, $2, 'Support', 7, 4)`, m.ID, w.wid)
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"imap_folders": []string{"INBOX", "Support"}}, nil); code != http.StatusOK {
		t.Fatalf("drop Archive: %d", code)
	}
	if w.count(`SELECT count(*) FROM mailbox_imap_folders WHERE mailbox_id = $1`, m.ID) != 1 ||
		w.count(`SELECT count(*) FROM mailbox_imap_folders WHERE mailbox_id = $1 AND name = 'Support'`, m.ID) != 1 {
		t.Fatal("Archive's cursor kept, or Support's dropped")
	}
	if code := doJSON(t, http.MethodPatch, url, map[string]any{"config": map[string]any{"imap_host": "127.0.0.2"}}, nil); code != http.StatusOK {
		t.Fatalf("move server: %d", code)
	}
	if w.count(`SELECT count(*) FROM mailbox_imap_folders WHERE mailbox_id = $1`, m.ID) != 0 {
		t.Fatal("cursors kept after moving to another server")
	}

	// A mailbox that does not read over IMAP has no folders to choose.
	fwd := w.mailbox(InboundForwarding, OutboundSystem, nil)
	if code := doJSON(t, http.MethodPatch, srv.URL+"/v1/mailboxes/"+fwd.ID.String(), map[string]any{"imap_folders": []string{"Archive"}}, nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("forwarding patch: %d", code)
	}
	if code := doJSON(t, http.MethodGet, srv.URL+"/v1/mailboxes/"+fwd.ID.String()+"/imap-folders", nil, nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("forwarding list: %d", code)
	}
}

func TestNormalizeFolders(t *testing.T) {
	got, err := normalizeFolders([]string{"Inbox", " Sales ", "Sales", "", "INBOX"})
	if err != nil || !slices.Equal(got, []string{"INBOX", "Sales"}) {
		t.Fatalf("%v %v", got, err)
	}
	if got, err := normalizeFolders([]string{"Sales", "Archive", "inbox"}); err != nil || !slices.Equal(got, []string{"INBOX", "Sales", "Archive"}) {
		t.Fatalf("INBOX first: %v %v", got, err)
	}
	if got, err := normalizeFolders([]string{"inbox"}); err != nil || len(got) != 0 {
		t.Fatalf("inbox alone: %v %v", got, err)
	}
	if got, err := normalizeFolders(nil); err != nil || len(got) != 0 {
		t.Fatalf("none: %v %v", got, err)
	}
}

func TestIMAPFolderList(t *testing.T) {
	list := []*imap.ListData{
		{Mailbox: "Work.Billing", Delim: '.'},
		{Mailbox: "[Gmail]", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrNoSelect}},
		{Mailbox: "[Gmail]/Sent Mail", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrSent}},
		{Mailbox: "Inbox", Delim: '/'},
	}
	got := imapFolderList(list)
	want := []IMAPFolder{{Name: "INBOX", Path: "INBOX", Special: "inbox"}, {Name: "[Gmail]/Sent Mail", Path: "[Gmail]/Sent Mail", Special: "sent"},
		{Name: "Work.Billing", Path: "Work/Billing"}}
	if !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}
}
