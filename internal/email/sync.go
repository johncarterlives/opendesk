package email

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// First-connect import window, and the most messages one pass ingests.
const (
	initialWindow = 7 * 24 * time.Hour
	initialMax    = 200
	syncBatch     = 100
)

// selectInfo is what SELECT told us about the folder.
type selectInfo struct {
	Validity uint32
	UIDNext  uint32 // 0 when the server did not say
	Exists   uint32
}

// planSync decides how to read the folder. initial is true on the first sync and
// whenever UIDVALIDITY changed (every stored UID is then meaningless); upToDate is true
// when UIDNEXT proves nothing arrived since lastUID.
func planSync(storedValidity, lastUID uint32, sel selectInfo) (initial, upToDate bool) {
	if storedValidity == 0 || storedValidity != sel.Validity {
		return true, sel.Exists == 0
	}
	if sel.Exists == 0 {
		return false, true
	}
	if sel.UIDNext != 0 && sel.UIDNext <= lastUID+1 {
		return false, true
	}
	return false, false
}

// newUIDs keeps UIDs above lastUID, ascending and unique. "UID n:*" always returns
// the newest message even when its UID is below n, so the filter is required.
func newUIDs(uids []uint32, lastUID uint32) []uint32 {
	out := make([]uint32, 0, len(uids))
	for _, u := range uids {
		if u > lastUID {
			out = append(out, u)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// finalCursor is the UID to store after a pass. After an initial import the cursor
// jumps to the end of the folder (older mail outside the window is not imported);
// otherwise it is the last UID processed.
func finalCursor(initial bool, processedLast uint32, sel selectInfo, complete bool) uint32 {
	last := processedLast
	if initial && complete && sel.UIDNext > 0 && sel.UIDNext-1 > last {
		last = sel.UIDNext - 1
	}
	return last
}

type candidate struct {
	uid  uint32
	size int64
}

// syncMailbox runs one pass over the folders the mailbox reads (INBOX unless it chose
// others). Failures are recorded on the mailbox (with a safe message and backoff) rather
// than retried by River; the periodic job tries again.
func (s *service) syncMailbox(ctx context.Context, id uuid.UUID) (err error) {
	m, err := scanMailbox(s.d.DB.Pool.QueryRow(ctx, `SELECT `+mailboxColumns+` FROM mailboxes WHERE id = $1`, id))
	if err != nil {
		if db.IsNotFound(err) {
			return nil
		}
		return err
	}
	if m.Status == "disabled" || !m.polled() {
		return nil
	}
	defer func() {
		if err == nil {
			s.refreshSendAs(ctx, m)
		}
	}()
	if m.readsAPI() {
		return s.syncAPI(ctx, m)
	}
	// While IMAP is off for its workspace the mailbox is kept as it is, unpolled.
	if ok, err := s.imapReceivesNow(ctx, m); err != nil || !ok {
		return err
	}
	start := time.Now()
	sess, err := s.dialIMAP(ctx, m)
	if err != nil {
		return s.recordSyncError(ctx, m, err)
	}
	defer sess.Close()
	c := sess.c

	// Each folder in turn, INBOX first. INBOX's cursor is the mailbox's own and is stored
	// with the pass. A folder the server refuses to open is skipped and named in last_error;
	// the others are still read.
	inbox := folderCursor{m.UIDValidity, m.LastUID}
	ingested := 0
	var skipped []string
	for _, name := range m.folders() {
		cur, err := s.loadFolderCursor(ctx, m, name)
		if err != nil {
			return err
		}
		next, n, err := s.syncFolder(ctx, c, m, name, cur)
		ingested += n
		if rec, ok := err.(errSyncRecorded); ok {
			return rec.err // recorded on the mailbox; the next pass tries again
		}
		if skip, ok := err.(errFolderSkipped); ok {
			s.log.Info("mailbox folder skipped", "mailbox_id", m.ID, "workspace_id", m.WorkspaceID, "reason", skip.msg)
			skipped = append(skipped, skip.msg)
			continue
		}
		if err != nil {
			return err
		}
		// Saved as each folder is done, so a later folder's failure keeps this one's progress.
		if name == inboxFolder {
			inbox = next
		}
		if err := s.saveCursor(ctx, m, name, next); err != nil {
			return err
		}
	}
	if err := s.setSyncOK(ctx, m, inbox.validity, inbox.lastUID, strings.Join(skipped, " ")); err != nil {
		return err
	}
	s.log.Debug("mailbox synced", "mailbox_id", m.ID, "workspace_id", m.WorkspaceID,
		"folders", len(m.folders()), "new_messages", ingested, "duration", time.Since(start))
	return nil
}

// syncFolder reads one folder from its cursor and answers the cursor to store and how many
// messages it took in. A failure the server caused is recorded on the mailbox (with the
// folder's progress saved) and ends the pass without an error, except a refused SELECT of a
// folder other than INBOX, which is errFolderSkipped; storage or database trouble is returned
// for River to log.
func (s *service) syncFolder(ctx context.Context, c *imapclient.Client, m *mailboxRow, name string, cur folderCursor) (folderCursor, int, error) {
	what := "opening INBOX"
	if name != inboxFolder {
		what = "opening the folder " + name
	}
	// fail records a failure; a listing failure saves nothing, as before a folder's first read.
	fail := func(err error) (folderCursor, int, error) {
		return cur, 0, errSyncRecorded{s.recordSyncError(ctx, m, err)}
	}
	// failAt also keeps the messages already taken in: the cursor stops at the last one.
	failAt := func(sel selectInfo, cursor uint32, n int, err error) (folderCursor, int, error) {
		if e := s.saveCursor(ctx, m, name, folderCursor{int64(sel.Validity), int64(cursor)}); e != nil {
			return cur, n, e
		}
		return cur, n, errSyncRecorded{s.recordSyncError(ctx, m, err)}
	}
	sd, err := c.Select(name, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		var refused *imap.Error
		if name != inboxFolder && errors.As(err, &refused) {
			// Renamed or removed on the server: the connection is fine, the other folders are read.
			return cur, 0, errFolderSkipped{safeError(opError(what, err))}
		}
		return fail(opError(what, err))
	}
	sel := selectInfo{Validity: sd.UIDValidity, UIDNext: uint32(sd.UIDNext), Exists: sd.NumMessages}
	done := func(lastUID uint32, n int) (folderCursor, int, error) {
		return folderCursor{int64(sel.Validity), int64(lastUID)}, n, nil
	}
	initial, upToDate := planSync(uint32(cur.validity), uint32(cur.lastUID), sel)
	lastUID := uint32(cur.lastUID)
	if initial {
		lastUID = 0
	}
	if upToDate {
		return done(finalCursor(initial, lastUID, sel, true), 0)
	}
	if initial && cur.validity == 0 && m.Config.SyncStart == SyncStartNew {
		// Only mail that arrives from now on: the cursor starts at the end of the folder.
		last, err := lastFolderUID(c, sel)
		if err != nil {
			return fail(opError("listing messages", err))
		}
		return done(last, 0)
	}

	var cands []candidate
	if initial {
		from := uint32(1)
		if sel.Exists > initialMax {
			from = sel.Exists - initialMax + 1
		}
		var set imap.SeqSet
		set.AddRange(from, sel.Exists)
		msgs, err := c.Fetch(set, &imap.FetchOptions{UID: true, InternalDate: true, RFC822Size: true}).Collect()
		if err != nil {
			return fail(opError("listing messages", err))
		}
		since := time.Now().Add(-initialWindow)
		for _, msg := range msgs {
			if msg.InternalDate.IsZero() || !msg.InternalDate.Before(since) {
				cands = append(cands, candidate{uid: uint32(msg.UID), size: msg.RFC822Size})
			}
		}
	} else {
		var set imap.UIDSet
		set.AddRange(imap.UID(lastUID+1), 0) // lastUID+1:*
		msgs, err := c.Fetch(set, &imap.FetchOptions{UID: true, RFC822Size: true}).Collect()
		if err != nil {
			return fail(opError("listing new messages", err))
		}
		sizes := map[uint32]int64{}
		uids := make([]uint32, 0, len(msgs))
		for _, msg := range msgs {
			uids = append(uids, uint32(msg.UID))
			sizes[uint32(msg.UID)] = msg.RFC822Size
		}
		for _, u := range newUIDs(uids, lastUID) {
			cands = append(cands, candidate{uid: u, size: sizes[u]})
		}
	}
	slices.SortFunc(cands, func(a, b candidate) int { return int(int64(a.uid) - int64(b.uid)) })
	complete := true
	if len(cands) > syncBatch && !initial {
		cands, complete = cands[:syncBatch], false
	}

	cursor, ingested := lastUID, 0
	for _, cand := range cands {
		if cand.size > maxRawBytes {
			s.log.Warn("skipping oversized message", "mailbox_id", m.ID, "uid", cand.uid, "bytes", cand.size)
			cursor = cand.uid
			continue
		}
		var set imap.UIDSet
		set.AddNum(imap.UID(cand.uid))
		msgs, err := c.Fetch(set, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{{Peek: true}}}).Collect()
		if err != nil {
			return failAt(sel, cursor, ingested, opError("fetching a message", err))
		}
		var raw []byte
		for _, msg := range msgs {
			if uint32(msg.UID) == cand.uid && len(msg.BodySection) > 0 {
				raw = msg.BodySection[0].Bytes
			}
		}
		if len(raw) > 0 && len(raw) <= maxRawBytes {
			if _, _, err := s.ingest(ctx, m, raw, "", nil, viaMailbox); err != nil {
				_ = s.saveCursor(ctx, m, name, folderCursor{int64(sel.Validity), int64(cursor)})
				return cur, ingested, err // storage or database trouble: let River log it
			}
			ingested++
		}
		cursor = cand.uid
	}
	return done(finalCursor(initial, cursor, sel, complete), ingested)
}

// errSyncRecorded is a folder failure already recorded on the mailbox: the pass ends and
// the periodic job tries again. err is what recording it returned (nil when it was stored).
type errSyncRecorded struct{ err error }

func (e errSyncRecorded) Error() string {
	if e.err != nil {
		return e.err.Error()
	}
	return "sync failure recorded"
}

// errFolderSkipped is a folder other than INBOX the server refused to open: the pass goes on
// without it and msg, safe to show, is kept on the mailbox.
type errFolderSkipped struct{ msg string }

func (e errFolderSkipped) Error() string { return e.msg }

// saveCursor stores a folder's progress after a failure part way: INBOX on the mailbox,
// another folder in its row.
func (s *service) saveCursor(ctx context.Context, m *mailboxRow, name string, c folderCursor) error {
	if name == inboxFolder {
		return s.saveProgress(ctx, m, c.validity, c.lastUID)
	}
	return s.saveFolderCursor(ctx, m, name, c)
}

// lastFolderUID is the UID of the newest message in the folder: UIDNEXT-1, or read from
// the last message when the server does not say.
func lastFolderUID(c *imapclient.Client, sel selectInfo) (uint32, error) {
	if sel.UIDNext > 0 {
		return sel.UIDNext - 1, nil
	}
	var set imap.SeqSet
	set.AddNum(sel.Exists)
	msgs, err := c.Fetch(set, &imap.FetchOptions{UID: true}).Collect()
	if err != nil {
		return 0, err
	}
	var last uint32
	for _, msg := range msgs {
		last = max(last, uint32(msg.UID))
	}
	return last, nil
}

func (s *service) recordSyncError(ctx context.Context, m *mailboxRow, err error) error {
	msg := safeError(err)
	s.log.Info("mailbox sync failed", "mailbox_id", m.ID, "workspace_id", m.WorkspaceID, "reason", msg)
	if e := s.setSyncError(ctx, m, msg); e != nil {
		return e
	}
	return nil
}

// syncDueArgs is the minute tick that enqueues a sync for every due polled mailbox.
type syncDueArgs struct{}

func (syncDueArgs) Kind() string { return "email.sync_due" }

type syncDueWorker struct {
	river.WorkerDefaults[syncDueArgs]
	s *service
}

func (w *syncDueWorker) Work(ctx context.Context, _ *river.Job[syncDueArgs]) error {
	return w.s.enqueueDue(ctx)
}

func (s *service) enqueueDue(ctx context.Context) error {
	list, err := s.dueMailboxes(ctx)
	if err != nil {
		return err
	}
	if len(list) > 0 {
		params := make([]river.InsertManyParams, 0, len(list))
		for _, id := range list {
			params = append(params, river.InsertManyParams{Args: jobs.SyncMailboxArgs{MailboxID: id}, InsertOpts: syncInsertOpts()})
		}
		if _, err := s.d.Jobs.InsertMany(ctx, params); err != nil {
			return err
		}
	}
	_, err = s.d.DB.Pool.Exec(ctx, `DELETE FROM email_auto_replies WHERE sent_at < now() - interval '1 day'`)
	return err
}

type syncMailboxWorker struct {
	river.WorkerDefaults[jobs.SyncMailboxArgs]
	s *service
}

func (w *syncMailboxWorker) Timeout(*river.Job[jobs.SyncMailboxArgs]) time.Duration {
	return sessionTimeout + time.Minute
}

func (w *syncMailboxWorker) Work(ctx context.Context, job *river.Job[jobs.SyncMailboxArgs]) error {
	return w.s.syncMailbox(ctx, job.Args.MailboxID)
}

// dueMailboxes lists the polled mailboxes due for a sync: those that read through the
// provider's API (of workspaces that are not suspended; one that lost Collab is queued
// so its sync reports why it stopped), and those that read over IMAP while that is on
// for their workspace. Entitlements are read once per workspace per tick.
func (s *service) dueMailboxes(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := s.d.DB.Pool.Query(ctx, `SELECT m.id, m.workspace_id, m.inbound_kind, coalesce(m.config->>'oauth_grant', '')
		FROM mailboxes m JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.inbound_kind IN ('imap', 'google', 'microsoft') AND m.status <> 'disabled'
		AND (m.next_sync_at IS NULL OR m.next_sync_at <= now())
		AND (coalesce(m.config->>'oauth_grant', '') <> 'api' OR w.suspended_at IS NULL)
		AND ($1 OR m.inbound_kind = 'imap' OR m.config->>'oauth_grant' = 'api')`, s.mailboxIMAP)
	if err != nil {
		return nil, err
	}
	type due struct {
		id, wid     uuid.UUID
		kind, grant string
	}
	var all []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.wid, &d.kind, &d.grant); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	allowed := map[uuid.UUID]bool{}
	out := make([]uuid.UUID, 0, len(all))
	for _, d := range all {
		if d.kind != InboundIMAP || s.mailboxIMAP {
			out = append(out, d.id) // api, or IMAP while the instance has it on
			continue
		}
		if !s.d.Cfg.CollabIMAP {
			continue
		}
		ok, seen := allowed[d.wid]
		if !seen {
			a, err := s.access(ctx, s.d.DB.Pool, d.wid)
			if err != nil {
				return nil, err
			}
			ok = s.imapAllowed(a)
			allowed[d.wid] = ok
		}
		if ok {
			out = append(out, d.id)
		}
	}
	return out, nil
}
