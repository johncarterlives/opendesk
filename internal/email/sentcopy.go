package email

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/emersion/go-imap/v2"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/storage"
)

// Sent copies (contracts/api.md "Mailboxes"): a mailbox that reads over IMAP and sends over
// SMTP, or through the platform mailer, keeps a copy of each email it sends in its
// imap_sent_folder, as a mail client does. Google and Microsoft keep their own when they send.
// The copy goes in by IMAP APPEND in a job of its own after the email went out, so storing
// it never delays, fails or repeats the send.

// sentCopyAttempts bounds how often a copy is tried before it is given up.
const sentCopyAttempts = 5

// sentCopyQueueTimeout bounds storing and queuing a copy inside the send job, so a slow
// store cannot use up the time the send has left to record its delivery.
const sentCopyQueueTimeout = 20 * time.Second

// keepsSentCopy reports a mailbox that stores a copy of what it sends in an IMAP folder.
func (m *mailboxRow) keepsSentCopy() bool {
	return m.IMAPSentFolder != "" && m.sentCopyPossible()
}

// sentCopyPossible reports a mailbox that may keep sent copies: it signs in to an IMAP
// server, and sends somewhere that keeps no copy in that mailbox.
func (m *mailboxRow) sentCopyPossible() bool {
	return m.readsIMAP() && (m.OutboundKind == OutboundSMTP || m.OutboundKind == OutboundSystem)
}

// normalizeSentFolder checks a requested sent folder: trimmed, "" for none, never INBOX
// (the mailbox would read its own replies back in).
func normalizeSentFolder(v string) (string, error) {
	name := strings.TrimSpace(v)
	if name == "" {
		return "", nil
	}
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxFolderName || strings.ContainsFunc(name, unicode.IsControl) {
		return "", httpx.Validation("A folder name must be plain text of at most 255 characters.")
	}
	if strings.EqualFold(name, inboxFolder) {
		return "", httpx.Validation("Keep sent email in a folder other than the inbox.")
	}
	return name, nil
}

// keepSentCopy queues a copy of raw, the email as it went out, for the mailbox's sent
// folder. The email is already sent: a failure here is logged and never returned, and it
// runs on its own short deadline, apart from the send job's.
func (s *service) keepSentCopy(ctx context.Context, m *mailboxRow, raw []byte) {
	if !m.keepsSentCopy() || len(raw) == 0 || len(raw) > maxRawBytes {
		return
	}
	sentAt := timeNow()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sentCopyQueueTimeout)
	defer cancel()
	key := "workspaces/" + m.WorkspaceID.String() + "/sent-copies/" + ids.New().String() + ".eml"
	if err := s.d.Storage.Put(ctx, key, bytes.NewReader(raw), int64(len(raw)), "message/rfc822"); err != nil {
		s.log.Warn("sent copy not stored", "mailbox_id", m.ID, "err", err)
		return
	}
	args := jobs.SentCopyArgs{WorkspaceID: m.WorkspaceID, MailboxID: m.ID, StorageKey: key, SentAt: sentAt}
	if _, err := s.d.Jobs.Insert(ctx, args, &river.InsertOpts{Queue: jobs.QueueEmail, MaxAttempts: sentCopyAttempts}); err != nil {
		s.log.Warn("sent copy not queued", "mailbox_id", m.ID, "err", err)
		_ = s.d.Storage.Delete(ctx, key)
	}
}

type sentCopyWorker struct {
	river.WorkerDefaults[jobs.SentCopyArgs]
	s *service
}

func (w *sentCopyWorker) Timeout(*river.Job[jobs.SentCopyArgs]) time.Duration {
	return sessionTimeout + time.Minute
}

func (w *sentCopyWorker) Work(ctx context.Context, job *river.Job[jobs.SentCopyArgs]) error {
	last := job.Attempt >= job.MaxAttempts
	err := w.s.storeSentCopy(ctx, job.Args)
	if err == nil || last || errors.Is(err, errSentCopyGone) {
		// Done, given up, or nothing left to store: the stored message goes, even when the
		// job's own time ran out.
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		if e := w.s.d.Storage.Delete(dctx, job.Args.StorageKey); e != nil && !errors.Is(e, storage.ErrNotFound) {
			w.s.log.Warn("sent copy not removed", "mailbox_id", job.Args.MailboxID, "err", e)
		}
		cancel()
	}
	if errors.Is(err, errSentCopyGone) {
		return nil
	}
	if err != nil && last {
		w.s.log.Warn("sent copy given up", "workspace_id", job.Args.WorkspaceID, "mailbox_id", job.Args.MailboxID,
			"attempts", job.Attempt, "reason", safeError(err))
		return nil
	}
	return err
}

// errSentCopyGone: the copy has nowhere to go any more (the mailbox is gone, or keeps no
// sent copies now), or nothing to store.
var errSentCopyGone = errors.New("sent copy no longer wanted")

// storeSentCopy appends the stored message to the mailbox's sent folder, marked read.
func (s *service) storeSentCopy(ctx context.Context, a jobs.SentCopyArgs) error {
	m, err := loadMailbox(ctx, s.d.DB.Pool, a.WorkspaceID, a.MailboxID)
	if db.IsNotFound(err) {
		return errSentCopyGone
	}
	if err != nil {
		return err
	}
	if !m.keepsSentCopy() || m.Status == "disabled" {
		return errSentCopyGone
	}
	if ok, err := s.imapReceivesNow(ctx, m); err != nil {
		return err
	} else if !ok {
		return errSentCopyGone
	}
	rc, err := s.d.Storage.Get(ctx, a.StorageKey)
	if errors.Is(err, storage.ErrNotFound) {
		return errSentCopyGone
	}
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(rc, maxRawBytes+1))
	_ = rc.Close()
	if err != nil {
		return err
	}
	if len(raw) == 0 || len(raw) > maxRawBytes {
		return errSentCopyGone
	}
	sess, err := s.dialIMAP(ctx, m)
	if err != nil {
		return err
	}
	defer sess.Close()
	sentAt := a.SentAt
	if sentAt.IsZero() {
		sentAt = timeNow() // a job queued before sent_at was recorded
	}
	cmd := sess.c.Append(m.IMAPSentFolder, int64(len(raw)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagSeen}, Time: sentAt})
	if _, err := cmd.Write(raw); err != nil {
		_ = cmd.Close()
		return opError("saving a copy in "+m.IMAPSentFolder, err)
	}
	if err := cmd.Close(); err != nil {
		return opError("saving a copy in "+m.IMAPSentFolder, err)
	}
	if _, err := cmd.Wait(); err != nil {
		return opError("saving a copy in "+m.IMAPSentFolder, err)
	}
	return nil
}
