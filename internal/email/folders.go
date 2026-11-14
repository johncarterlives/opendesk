package email

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/emersion/go-imap/v2"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// IMAP folders (contracts/api.md "Mailboxes"): a mailbox that reads over IMAP takes mail from
// the folders in imap_folders, INBOX when none. INBOX's cursor stays on the mailbox
// (imap_uid_validity, imap_last_uid); every other folder's is a mailbox_imap_folders row.

const (
	inboxFolder = "INBOX"
	// maxIMAPFolders bounds the folders one mailbox reads, and so one sync pass's work.
	maxIMAPFolders = 10
	// maxFolderName bounds a folder name, in characters.
	maxFolderName = 255
	// folderListsPerMinute bounds how often a mailbox's folders are listed from the server.
	folderListsPerMinute = 6
)

// folders are the folders the mailbox reads, in order: imap_folders, or INBOX alone.
func (m *mailboxRow) folders() []string {
	if len(m.IMAPFolders) == 0 {
		return []string{inboxFolder}
	}
	return m.IMAPFolders
}

// normalizeFolders checks and tidies a requested folder list: names trimmed, INBOX in any
// case spelled INBOX and read first, duplicates dropped, the other folders' order kept. A
// list of INBOX alone is stored empty, the default. It answers a safe validation error for a
// list it refuses.
func normalizeFolders(in []string) ([]string, error) {
	out := []string{}
	for _, raw := range in {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if strings.EqualFold(name, inboxFolder) {
			name = inboxFolder
		}
		if !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxFolderName ||
			strings.ContainsFunc(name, unicode.IsControl) {
			return nil, httpx.Validation("A folder name must be plain text of at most 255 characters.")
		}
		if !slices.Contains(out, name) {
			out = append(out, name)
		}
	}
	if len(out) > maxIMAPFolders {
		return nil, httpx.Validation("A mailbox can read at most 10 folders.")
	}
	if i := slices.Index(out, inboxFolder); i > 0 {
		out = slices.Insert(slices.Delete(out, i, i+1), 0, inboxFolder)
	}
	if len(out) == 1 && out[0] == inboxFolder {
		return []string{}, nil
	}
	return out, nil
}

// folderCursor is how far a folder was read: its UIDVALIDITY and the last UID taken.
type folderCursor struct{ validity, lastUID int64 }

// loadFolderCursor reads a folder's cursor; a folder never read starts at zero.
func (s *service) loadFolderCursor(ctx context.Context, m *mailboxRow, name string) (folderCursor, error) {
	if name == inboxFolder {
		return folderCursor{m.UIDValidity, m.LastUID}, nil
	}
	var c folderCursor
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT uid_validity, last_uid FROM mailbox_imap_folders
		WHERE workspace_id = $1 AND mailbox_id = $2 AND name = $3`, m.WorkspaceID, m.ID, name).Scan(&c.validity, &c.lastUID)
	if db.IsNotFound(err) {
		return folderCursor{}, nil
	}
	return c, err
}

// saveFolderCursor stores how far a folder other than INBOX was read, while the mailbox
// still reads it: a pass that raced the folder's removal stores nothing.
func (s *service) saveFolderCursor(ctx context.Context, m *mailboxRow, name string, c folderCursor) error {
	_, err := s.d.DB.Pool.Exec(ctx, `INSERT INTO mailbox_imap_folders (mailbox_id, workspace_id, name, uid_validity, last_uid)
		SELECT m.id, m.workspace_id, $3, $4, $5 FROM mailboxes m
		WHERE m.workspace_id = $1 AND m.id = $2 AND $3 = ANY(m.imap_folders)
		ON CONFLICT (mailbox_id, name) DO UPDATE SET uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid`,
		m.WorkspaceID, m.ID, name, c.validity, c.lastUID)
	return err
}

// forgetFolderCursors drops the cursors of folders the mailbox no longer reads, or all of
// them (every: the mailbox moved to another account or server), in the update's transaction.
// INBOX's cursor is dropped too while the mailbox does not read it, so ticking it again reads
// it as a new connection does (config.sync_start), not everything that arrived in between.
func forgetFolderCursors(ctx context.Context, tx pgx.Tx, m *mailboxRow, every bool) error {
	if _, err := tx.Exec(ctx, `DELETE FROM mailbox_imap_folders WHERE workspace_id = $1 AND mailbox_id = $2
		AND ($3 OR NOT (name = ANY($4)))`, m.WorkspaceID, m.ID, every, m.folders()); err != nil {
		return err
	}
	if slices.Contains(m.folders(), inboxFolder) {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE mailboxes SET imap_uid_validity = 0, imap_last_uid = 0
		WHERE workspace_id = $1 AND id = $2`, m.WorkspaceID, m.ID)
	return err
}

// readsInboxSQL is true while a mailboxes row reads INBOX: a pass stores INBOX's cursor only
// then, so one that raced INBOX's removal does not bring the old cursor back.
const readsInboxSQL = `(imap_folders = '{}' OR 'INBOX' = ANY(imap_folders))`

// IMAPFolder is a folder on the mailbox's IMAP server that it can read.
type IMAPFolder struct {
	Name    string `json:"name" doc:"The folder's name on the server, as imap_folders takes it"`
	Path    string `json:"path" doc:"The name with / between levels, for showing"`
	Special string `json:"special" enum:",inbox,sent,drafts,trash,junk,archive,all,flagged,important" doc:"What the server says the folder is for (SPECIAL-USE), or empty"`
}

type imapFoldersOutput struct {
	Body struct {
		Folders  []IMAPFolder `json:"folders"`
		Selected []string     `json:"selected" doc:"The folders the mailbox reads now"`
	}
}

// imapSpecialUse names the SPECIAL-USE attributes a folder list shows.
var imapSpecialUse = map[imap.MailboxAttr]string{
	imap.MailboxAttrSent: "sent", imap.MailboxAttrDrafts: "drafts", imap.MailboxAttrTrash: "trash",
	imap.MailboxAttrJunk: "junk", imap.MailboxAttrArchive: "archive", imap.MailboxAttrAll: "all",
	imap.MailboxAttrFlagged: "flagged", imap.MailboxAttrImportant: "important",
}

// imapFolderList maps LIST answers to the folders a mailbox can read: INBOX first, then by
// path, without the ones that cannot be opened.
func imapFolderList(list []*imap.ListData) []IMAPFolder {
	out := []IMAPFolder{}
	for _, l := range list {
		if l == nil || slices.Contains(l.Attrs, imap.MailboxAttrNoSelect) || slices.Contains(l.Attrs, imap.MailboxAttrNonExistent) {
			continue
		}
		f := IMAPFolder{Name: l.Mailbox, Path: l.Mailbox}
		if l.Delim != 0 && l.Delim != '/' {
			f.Path = strings.ReplaceAll(l.Mailbox, string(l.Delim), "/")
		}
		if strings.EqualFold(l.Mailbox, inboxFolder) {
			f.Name, f.Path, f.Special = inboxFolder, inboxFolder, "inbox"
		}
		for _, attr := range l.Attrs {
			for special, name := range imapSpecialUse {
				if f.Special == "" && strings.EqualFold(string(attr), string(special)) {
					f.Special = name
				}
			}
		}
		out = append(out, f)
	}
	slices.SortStableFunc(out, func(a, b IMAPFolder) int {
		switch {
		case a.Name == inboxFolder && b.Name != inboxFolder:
			return -1
		case b.Name == inboxFolder && a.Name != inboxFolder:
			return 1
		}
		return strings.Compare(strings.ToLower(a.Path), strings.ToLower(b.Path))
	})
	return slices.CompactFunc(out, func(a, b IMAPFolder) bool { return a.Name == b.Name })
}

func (s *service) registerFolderRoutes(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-mailbox-imap-folders", Method: http.MethodGet, Path: "/v1/mailboxes/{id}/imap-folders",
		Summary: "List a mailbox's IMAP folders", Tags: []string{"Mailboxes"},
		Description: "For a mailbox that reads its inbox over IMAP: signs in to the server and lists the folders it can read, for choosing imap_folders. 422 not_imap for any other mailbox; 422 imap_failed with the server's reason when it cannot be read."},
		func(ctx context.Context, in *idInput) (*imapFoldersOutput, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			m, err := loadMailbox(ctx, s.d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, wrapMailboxErr(err)
			}
			if !m.readsIMAP() {
				return nil, httpx.E(http.StatusUnprocessableEntity, "not_imap", "Only a mailbox that reads its inbox over IMAP has folders to choose.")
			}
			if !s.d.Limiter.Allow("mailbox-imap-folders:"+id.String(), folderListsPerMinute, time.Minute) {
				return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Wait a minute before listing the folders again.")
			}
			folders, err := s.listIMAPFolders(ctx, m)
			if err != nil {
				return nil, err
			}
			out := &imapFoldersOutput{}
			out.Body.Folders = folders
			out.Body.Selected = m.folders()
			return out, nil
		})
}

// listIMAPFolders signs in to the mailbox's server and lists the folders it can read. A
// failure answers 422 imap_failed with a message that is safe to show.
func (s *service) listIMAPFolders(ctx context.Context, m *mailboxRow) ([]IMAPFolder, error) {
	sess, err := s.dialIMAP(ctx, m)
	if err != nil {
		return nil, imapFailed(err)
	}
	defer sess.Close()
	var opts *imap.ListOptions
	if sess.c.Caps().Has(imap.CapSpecialUse) {
		opts = &imap.ListOptions{ReturnSpecialUse: true}
	}
	list, err := sess.c.List("", "*", opts).Collect()
	if err != nil {
		return nil, imapFailed(opError("listing folders", err))
	}
	return imapFolderList(list), nil
}

// imapFailed turns an IMAP failure into the 422 a folder list answers; anything that is
// not a safe IMAP message stays a logged 500.
func imapFailed(err error) error {
	if ie, ok := err.(*imapError); ok {
		return httpx.E(http.StatusUnprocessableEntity, "imap_failed", ie.msg)
	}
	return err
}
