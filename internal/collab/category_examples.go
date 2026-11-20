package collab

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/email"
)

// Learning from moves (contracts/collab.md "Categories", "Learning from moves"): a conversation a
// member moves to a category by hand is kept as an example of that account's sorting, and Ollie
// is shown the account's recent examples when it sorts its new mail, so similar mail lands where
// the member put it. Examples are read only by the account's own sorting; no route returns them
// and no event carries them.

const (
	examplesPerCategory = 20  // kept per account and category, the latest
	examplesPerAccount  = 100 // kept per account, the latest
	exampleSubject      = 150 // runes of a subject kept
	exampleSnippet      = 200 // runes of the text kept
	exampleName         = 80  // runes of the sender's name kept

	promptExamples            = 16   // examples in one sorting call at most
	promptExamplesPerCategory = 4    // of one category
	promptExampleChars        = 6000 // their sender, subject and text together

	resortSimilarMax  = 25 // the sender's other inbox conversations sorted again after a move
	resortSimilarDays = 30
)

// categoryExample is one conversation a member moved.
type categoryExample struct {
	ThreadID   uuid.UUID
	Sender     string
	SenderName string
	Subject    string
	Snippet    string
	Signals    []string
	From       *string
	Category   string
	CreatedAt  time.Time
}

// movedThread is a conversation moved by hand and the category it showed before.
type movedThread struct {
	ID   uuid.UUID
	From string
}

// learnFromMoves records the conversations of a locally sorted account that a member moved to key,
// in tx: each one's latest mail from someone else, the category it left and the one it went to. A
// conversation moved back to the category its kept move left (Undo) is forgotten instead. The
// account keeps its latest examples per category and in all. Then the moved senders' other recent
// inbox conversations that sorting placed are sorted again, with these examples.
func (s *service) learnFromMoves(ctx context.Context, tx pgx.Tx, a *accountRow, moved []movedThread, key string) error {
	idents, err := accountIdentities(ctx, tx, a)
	if err != nil {
		return err
	}
	own := ownAddresses(a, idents)
	var senders []string
	for _, m := range moved {
		if m.From == key {
			continue
		}
		var kept *string
		err := tx.QueryRow(ctx, `SELECT from_category FROM collab_category_examples WHERE thread_id = $1 AND account_id = $2`, m.ID, a.ID).Scan(&kept)
		if err != nil && !db.IsNotFound(err) {
			return err
		}
		if err == nil && kept != nil && *kept == key {
			if _, err := tx.Exec(ctx, `DELETE FROM collab_category_examples WHERE thread_id = $1 AND account_id = $2`, m.ID, a.ID); err != nil {
				return err
			}
			continue
		}
		ex, ok, err := latestFromOthers(ctx, tx, a.ID, m.ID)
		if err != nil {
			return err
		}
		if !ok || ex.Sender == "" || slices.Contains(own, ex.Sender) {
			continue // nothing from outside the account to learn from
		}
		from := &m.From
		if m.From == "" {
			from = nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO collab_category_examples
			(thread_id, workspace_id, account_id, sender, sender_name, subject, snippet, signals, from_category, category)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (thread_id) DO UPDATE SET sender = EXCLUDED.sender, sender_name = EXCLUDED.sender_name,
				subject = EXCLUDED.subject, snippet = EXCLUDED.snippet, signals = EXCLUDED.signals,
				from_category = EXCLUDED.from_category, category = EXCLUDED.category, created_at = now()`,
			m.ID, a.WorkspaceID, a.ID, ex.Sender, ex.SenderName, ex.Subject, ex.Snippet, nonNilStrings(ex.Signals), from, key); err != nil {
			return err
		}
		if !slices.Contains(senders, ex.Sender) {
			senders = append(senders, ex.Sender)
		}
	}
	if err := pruneCategoryExamples(ctx, tx, a.ID); err != nil {
		return err
	}
	return s.resortSimilar(ctx, tx, a, senders)
}

// latestFromOthers is a conversation's latest message the account did not send, as an example.
func latestFromOthers(ctx context.Context, q db.Querier, accountID, threadID uuid.UUID) (categoryExample, bool, error) {
	var ex categoryExample
	var from Address
	err := q.QueryRow(ctx, `SELECT COALESCE(m.from_addr, '{}'), COALESCE(m.subject, ''), COALESCE(left(m.body_text, $3), ''), COALESCE(m.signals, '{}')
		FROM collab_messages m JOIN collab_threads t ON t.id = m.thread_id
		WHERE m.thread_id = $2 AND t.account_id = $1 AND m.sent_by IS NULL AND NOT m.draft AND m.from_addr IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM collab_message_folders mf JOIN collab_folders f ON f.id = mf.folder_id
				WHERE mf.message_id = m.id AND f.role IN ('sent', 'drafts'))
		ORDER BY m.sent_at DESC LIMIT 1`, accountID, threadID, exampleSnippet*4).Scan(&from, &ex.Subject, &ex.Snippet, &ex.Signals)
	if db.IsNotFound(err) {
		return ex, false, nil
	}
	if err != nil {
		return ex, false, err
	}
	ex.ThreadID = threadID
	ex.Sender = strings.ToLower(strings.TrimSpace(from.Email))
	ex.SenderName = cleanLine(from.Name, exampleName)
	ex.Subject = cleanLine(ex.Subject, exampleSubject)
	ex.Snippet = cleanLine(ex.Snippet, exampleSnippet)
	return ex, true, nil
}

// pruneCategoryExamples keeps an account's latest examples: per category and in all.
func pruneCategoryExamples(ctx context.Context, q db.Querier, accountID uuid.UUID) error {
	_, err := q.Exec(ctx, `DELETE FROM collab_category_examples WHERE account_id = $1 AND thread_id IN (
		SELECT thread_id FROM (SELECT thread_id,
			row_number() OVER (PARTITION BY category ORDER BY created_at DESC, thread_id) AS in_category,
			row_number() OVER (ORDER BY created_at DESC, thread_id) AS in_account
			FROM collab_category_examples WHERE account_id = $1) x
		WHERE in_category > $2 OR in_account > $3)`, accountID, examplesPerCategory, examplesPerAccount)
	return err
}

// forgetCategoryExamples drops an account's examples of categories it no longer has.
func forgetCategoryExamples(ctx context.Context, q db.Querier, accountID uuid.UUID, keys []string) error {
	_, err := q.Exec(ctx, `DELETE FROM collab_category_examples WHERE account_id = $1 AND NOT (category = ANY($2))`, accountID, nonNilStrings(keys))
	return err
}

// resortSimilar sorts again the senders' other recent inbox conversations that sorting placed
// (never one a member moved, nor one a rule, a reply or a known correspondent placed): the sender's
// domain, or the address alone at a provider anyone can sign up to. Bounded; the categorize job
// runs them with the account's examples, within the workspace's AI balance like any sorting.
func (s *service) resortSimilar(ctx context.Context, tx pgx.Tx, a *accountRow, senders []string) error {
	if len(senders) == 0 {
		return nil
	}
	var likes []string
	for _, sender := range senders {
		d := domainOf(sender)
		if d == "" || email.PublicMailDomain(d) {
			likes = append(likes, escapeLike(sender))
		} else {
			likes = append(likes, "%@"+escapeLike(d))
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE collab_threads SET category_pending = true WHERE id IN (
		SELECT t.id FROM collab_threads t WHERE t.account_id = $1 AND NOT t.category_pending
			AND t.folder_ids && ARRAY(SELECT id FROM collab_folders WHERE account_id = $1 AND role = 'inbox')
			AND t.last_message_at > now() - make_interval(days => $3)
			AND COALESCE(t.category_source, '') IN ('', 'ai', 'headers', 'gmail')
			AND EXISTS (SELECT 1 FROM collab_messages m WHERE m.thread_id = t.id AND m.sent_by IS NULL
				AND lower(m.from_addr->>'email') LIKE ANY($2))
		ORDER BY t.last_message_at DESC LIMIT $4)`, a.ID, likes, resortSimilarDays, resortSimilarMax)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return s.queueCategorize(ctx, tx, a.ID)
}

// accountExamples are an account's examples of these categories, latest first.
func accountExamples(ctx context.Context, q db.Querier, accountID uuid.UUID, keys []string) ([]categoryExample, error) {
	rows, err := q.Query(ctx, `SELECT thread_id, sender, sender_name, subject, snippet, signals, from_category, category, created_at
		FROM collab_category_examples WHERE account_id = $1 AND category = ANY($2)
		ORDER BY created_at DESC, thread_id LIMIT $3`, accountID, nonNilStrings(keys), examplesPerAccount)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[categoryExample])
}

// pickExamples chooses the examples one sorting call is shown: first those from a sender, then a
// domain, of the conversations it sorts, then the latest; a few per category, within a size.
func pickExamples(all []categoryExample, batch []*sortItem) []categoryExample {
	senders, domains := map[string]bool{}, map[string]bool{}
	for _, it := range batch {
		senders[it.From.Email] = true
		if d := domainOf(it.From.Email); d != "" && !email.PublicMailDomain(d) {
			domains[d] = true
		}
	}
	rank := func(e categoryExample) int {
		switch {
		case senders[e.Sender]:
			return 0
		case domains[domainOf(e.Sender)]:
			return 1
		}
		return 2
	}
	order := slices.Clone(all) // latest first
	slices.SortStableFunc(order, func(x, y categoryExample) int { return rank(x) - rank(y) })
	var out []categoryExample
	per := map[string]int{}
	size := 0
	for _, e := range order {
		n := len(e.Sender) + len(e.SenderName) + len(e.Subject) + len(e.Snippet)
		if len(out) == promptExamples {
			break
		}
		if per[e.Category] == promptExamplesPerCategory || size+n > promptExampleChars {
			continue
		}
		per[e.Category]++
		size += n
		out = append(out, e)
	}
	return out
}

// promptExample is an example as the decision's state shows it: data, like the mail it sorts.
func promptExample(e categoryExample) map[string]any {
	from := e.Sender
	if e.SenderName != "" {
		from = e.SenderName + " <" + e.Sender + ">"
	}
	return map[string]any{"from": from, "subject": e.Subject, "text": e.Snippet, "signals": nonNilStrings(e.Signals), "category": e.Category}
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
