package collab

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// refreshCategoryPolicy runs with the account locked. Configuration changes install
// effective keys synchronously and revoke the authority of previously queued results.
func (s *service) refreshCategoryPolicy(ctx context.Context, tx pgx.Tx, a *accountRow) error {
	cs, err := loadAccountCategorySets(ctx, tx, a)
	if err != nil {
		return err
	}
	c := cs.resolve(a)
	keys := categoryKeys(c)
	if a.CategoryEngine == c.Engine && slices.Equal(a.CategoryKeys, keys) {
		return nil
	}
	old := a.CategoryEngine
	a.CategoryEpoch++
	a.CategoryEngine, a.CategoryKeys = c.Engine, keys
	var refresh any
	if c.Engine == modeGmail {
		refresh = []byte(`{}`)
	}
	if _, err := tx.Exec(ctx, `UPDATE collab_accounts SET category_engine = $2, category_keys = $3,
        category_epoch = $4, category_sig = '', category_refresh = $5 WHERE id = $1`, a.ID, c.Engine, keys, a.CategoryEpoch, refresh); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE collab_category_intents SET state = 'canceled', updated_at = now()
        WHERE account_id = $1 AND state IN ('pending','confirming','blocked')`, a.ID); err != nil {
		return err
	}
	if old == modeGmail || c.Engine == modeGmail || len(keys) == 0 {
		if _, err := tx.Exec(ctx, `UPDATE collab_threads SET category = NULL, category_source = NULL, category_pending = false WHERE account_id = $1`, a.ID); err != nil {
			return err
		}
	}
	if c.Engine == modeGmail {
		if err := projectGmailCategories(ctx, tx, a, nil); err != nil {
			return err
		}
		if err := s.queueSync(ctx, tx, a.ID); err != nil {
			return err
		}
	}
	if err := s.publishAccounts(ctx, tx, a.WorkspaceID, a.ID, nil); err != nil {
		return err
	}
	return s.publishChanged(ctx, tx, a.WorkspaceID, &a.ID, nil, true)
}

func (s *service) refreshWorkspaceCategoryPolicies(ctx context.Context, tx pgx.Tx, wid uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT id FROM collab_accounts WHERE workspace_id = $1 ORDER BY id`, wid)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	for _, id := range ids {
		a, err := loadAccountForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := s.refreshCategoryPolicy(ctx, tx, a); err != nil {
			return err
		}
	}
	return nil
}

func (s *service) queueCategoryIntent(ctx context.Context, tx pgx.Tx, a *accountRow, id uuid.UUID) error {
	if s.d.Jobs == nil {
		return nil
	}
	_, err := s.d.Jobs.InsertTx(ctx, tx, jobs.CollabApplyArgs{WorkspaceID: a.WorkspaceID, AccountID: a.ID,
		Action: ActionCategorize, CategoryIntentID: &id}, &river.InsertOpts{Queue: jobs.QueueEmail, MaxAttempts: 8})
	return err
}

func (s *service) chooseCategories(ctx context.Context, p *auth.Principal, threads []*threadRow, key string) error {
	accountIDs := []uuid.UUID{}
	for _, t := range threads {
		accountIDs = appendNew(accountIDs, t.AccountID)
	}
	sort.Slice(accountIDs, func(i, j int) bool { return accountIDs[i].String() < accountIDs[j].String() })
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		accounts := map[uuid.UUID]*accountRow{}
		policies := map[uuid.UUID]MailAccountCategories{}
		for _, id := range accountIDs {
			a, err := loadAccountForUpdate(ctx, tx, id)
			if err != nil {
				return err
			}
			if a.WorkspaceID != p.WorkspaceID {
				return httpx.NotFound("Account")
			}
			cs, err := loadAccountCategorySets(ctx, tx, a)
			if err != nil {
				return err
			}
			c := cs.resolve(a)
			if !slices.Contains(categoryKeys(c), key) {
				return httpx.Validation("Choose one of the inbox's categories.")
			}
			if err := s.refreshCategoryPolicy(ctx, tx, a); err != nil {
				return err
			}
			accounts[id], policies[id] = a, c
		}
		visibleIDs := make([]uuid.UUID, 0, len(threads))
		for _, t := range threads {
			visibleIDs = append(visibleIDs, t.ID)
		}
		visible, err := visibleThreads(ctx, tx, p, visibleIDs)
		if err != nil {
			return err
		}
		if len(visible) != len(threads) {
			return httpx.NotFound("Conversation")
		}
		tids := []uuid.UUID{}
		for _, t := range threads {
			a := accounts[t.AccountID]
			// Revalidate identity inside the transaction; a removed conversation is not an admission.
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collab_threads WHERE workspace_id = $1 AND account_id = $2 AND id = $3)`,
				p.WorkspaceID, a.ID, t.ID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return httpx.NotFound("Conversation")
			}
			if policies[a.ID].Engine == modeGmail {
				intentID := ids.New()
				_, err := tx.Exec(ctx, `INSERT INTO collab_category_intents (thread_id,workspace_id,account_id,id,epoch,desired,state)
                    VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (thread_id) DO UPDATE SET id = EXCLUDED.id,
                    epoch = EXCLUDED.epoch, desired = EXCLUDED.desired, state = 'pending', error_code = '', updated_at = now()`,
					t.ID, p.WorkspaceID, a.ID, intentID, a.CategoryEpoch, key)
				if err != nil {
					return err
				}
				if err := s.queueCategoryIntent(ctx, tx, a, intentID); err != nil {
					return err
				}
			}
			source := sortedByPerson
			if policies[a.ID].Engine == modeGmail {
				source = sortedByGmail
			}
			if _, err := tx.Exec(ctx, `UPDATE collab_threads SET category = $4, category_source = $5, category_pending = false
                WHERE workspace_id = $1 AND account_id = $2 AND id = $3`, p.WorkspaceID, a.ID, t.ID, key, source); err != nil {
				return err
			}
			tids = append(tids, t.ID)
		}
		for _, id := range accountIDs {
			if policies[id].Engine == modeGmail {
				if err := s.publishAccounts(ctx, tx, p.WorkspaceID, id, nil); err != nil {
					return err
				}
			}
		}
		return s.publishChanged(ctx, tx, p.WorkspaceID, nil, tids, true)
	})
}

var errCategorySuperseded = errors.New("category request superseded")

type categoryIntent struct {
	ID, ThreadID           uuid.UUID
	Epoch                  int64
	Desired, State, Remote string
}

func (s *service) currentCategoryIntent(ctx context.Context, a *accountRow, id uuid.UUID) (*categoryIntent, error) {
	var i categoryIntent
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT i.id,i.thread_id,i.epoch,i.desired,i.state,t.remote_id
        FROM collab_category_intents i JOIN collab_threads t ON t.id = i.thread_id
        WHERE i.workspace_id = $1 AND i.account_id = $2 AND i.id = $3 AND i.epoch = $4
        AND i.state IN ('pending','confirming','blocked')`, a.WorkspaceID, a.ID, id, a.CategoryEpoch).
		Scan(&i.ID, &i.ThreadID, &i.Epoch, &i.Desired, &i.State, &i.Remote)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cs, err := loadAccountCategorySets(ctx, s.d.DB.Pool, a)
	if err != nil || cs.resolve(a).Engine != modeGmail {
		return nil, err
	}
	return &i, nil
}

func (g *gmailProvider) categoryThread(ctx context.Context, remote string) ([]gmailMessage, error) {
	var out struct {
		Messages []gmailMessage `json:"messages"`
	}
	err := g.do(ctx, http.MethodGet, "/threads/"+url.PathEscape(remote)+"?format=minimal", nil, &out)
	return out.Messages, err
}

func categoriesMatch(msgs []gmailMessage, key string) bool {
	found := false
	for j := range msgs {
		if slices.Contains(msgs[j].LabelIDs, "DRAFT") {
			continue
		}
		ob, err := gmailObservation(&msgs[j])
		if err != nil || ob.Mask != gmailCategoryBit(key) {
			return false
		}
		found = true
	}
	return found
}

func (s *service) storeCategoryReadback(ctx context.Context, a *accountRow, i *categoryIntent, msgs []gmailMessage, state, code string, gone bool) error {
	p, err := s.newPass(ctx, s.d.DB.Pool, a)
	if err != nil {
		return err
	}
	return p.batch(ctx, func(tx pgx.Tx) error {
		for j := range msgs {
			m, err := p.lookup(ctx, tx, msgs[j].ID)
			if err != nil {
				return err
			}
			if m == nil {
				continue
			} // no body imports during readback
			ob, err := gmailObservation(&msgs[j])
			if err != nil {
				return err
			}
			st := p.gmailState(msgs[j].LabelIDs)
			st.Gmail = ob
			if err := p.update(ctx, tx, m, st); err != nil {
				return err
			}
		}
		if gone {
			known, err := actionMessages(ctx, tx, a, []uuid.UUID{i.ThreadID})
			if err != nil {
				return err
			}
			for _, m := range known {
				if err := p.remove(ctx, tx, m.storedMsg); err != nil {
					return err
				}
			}
		}
		// The UUID is a revision: completion of A cannot clear a newer B.
		if _, err := tx.Exec(ctx, `UPDATE collab_category_intents SET state = $4, error_code = $5, updated_at = now()
            WHERE workspace_id = $1 AND account_id = $2 AND id = $3 AND state IN ('pending','confirming','blocked')`, a.WorkspaceID, a.ID, i.ID, state, code); err != nil {
			return err
		}
		p.touch(i.ThreadID)
		return s.publishAccounts(ctx, tx, a.WorkspaceID, a.ID, nil)
	})
}

func (s *service) deliverCategoryIntent(ctx context.Context, job *river.Job[jobs.CollabApplyArgs]) error {
	args := job.Args
	if args.CategoryIntentID == nil || args.Action != ActionCategorize || len(args.ThreadIDs) != 0 || args.FolderID != nil {
		return river.JobCancel(httpx.Validation("Invalid category delivery job."))
	}
	// A dedicated transaction holds no business rows and never uses session locks.
	lockCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	lock, err := s.d.DB.Locks.Begin(lockCtx)
	if err != nil {
		return err
	}
	defer lock.Rollback(context.WithoutCancel(ctx))
	var locked bool
	if err := lock.QueryRow(lockCtx, `SELECT pg_try_advisory_xact_lock(hashtextextended('collab_category:' || $1::text,0))`, args.AccountID).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return river.JobSnooze(5 * time.Second)
	}
	a, err := loadAccount(ctx, s.d.DB.Pool, args.WorkspaceID, args.AccountID)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if ok, err := s.collabActive(ctx, a.WorkspaceID); err != nil || !ok {
		return err
	}
	i, err := s.currentCategoryIntent(ctx, a, *args.CategoryIntentID)
	if err != nil || i == nil {
		return err
	}
	if a.Reconnect {
		return s.storeCategoryReadback(ctx, a, i, nil, "blocked", "reconnect", false)
	}
	if a.Provider != ProviderGoogle || a.Config.Demo {
		return s.storeCategoryReadback(ctx, a, i, nil, "failed", "provider", false)
	}
	prov, err := s.provider(ctx, a)
	if err != nil {
		return err
	}
	defer prov.Close()
	g, ok := prov.(*gmailProvider)
	if !ok {
		return s.storeCategoryReadback(ctx, a, i, nil, "failed", "provider", false)
	}
	// Bound the lock's occupancy even when a provider stalls.
	ctx, stop := context.WithTimeout(ctx, 90*time.Second)
	defer stop()
	msgs, err := g.categoryThread(ctx, i.Remote)
	if isNotFound(err) {
		return s.storeCategoryReadback(ctx, a, i, nil, "failed", "gone", true)
	}
	if err == nil && i.State != "confirming" && !categoriesMatch(msgs, i.Desired) {
		// Network read may overlap a mode change or a newer admission.
		a, err = loadAccount(ctx, s.d.DB.Pool, args.WorkspaceID, args.AccountID)
		if err != nil {
			return err
		}
		current, e := s.currentCategoryIntent(ctx, a, i.ID)
		if e != nil || current == nil {
			return e
		}
		err = prov.Apply(ctx, ApplyOp{Action: ActionCategorize, category: &gmailCategoryChange{Thread: i.Remote, Messages: msgs, Key: i.Desired, current: func(ctx context.Context) error {
			currentAccount, err := loadAccount(ctx, s.d.DB.Pool, args.WorkspaceID, args.AccountID)
			if db.IsNotFound(err) {
				return errCategorySuperseded
			}
			if err != nil {
				return err
			}
			current, err := s.currentCategoryIntent(ctx, currentAccount, i.ID)
			if err != nil {
				return err
			}
			if current == nil {
				return errCategorySuperseded
			}
			if currentAccount.Reconnect {
				return errReconnect
			}
			return nil
		}}})
		if err == nil {
			_, err = s.d.DB.Pool.Exec(ctx, `UPDATE collab_category_intents SET state = 'confirming', updated_at = now() WHERE id = $1 AND state IN ('pending','blocked')`, i.ID)
			if err == nil {
				msgs, err = g.categoryThread(ctx, i.Remote)
			}
		}
	}
	if errors.Is(err, errCategorySuperseded) {
		return nil
	}
	if err == nil {
		return s.storeCategoryReadback(ctx, a, i, msgs, "applied", "", false)
	}
	if isReconnect(err) {
		if e := s.recordSyncError(ctx, a, err); e != nil {
			return e
		}
		return s.storeCategoryReadback(ctx, a, i, nil, "blocked", "reconnect", false)
	}
	if isPermanent(err) || job.Attempt >= job.MaxAttempts {
		// Revert to the last authoritative metadata even when the refusal readback fails.
		fresh, readErr := g.categoryThread(ctx, i.Remote)
		if readErr != nil {
			fresh = nil
			if _, e := s.d.DB.Pool.Exec(ctx, `UPDATE collab_accounts SET category_refresh = '{}' WHERE id = $1 AND category_epoch = $2 AND category_engine = 'gmail' AND category_refresh IS NULL`, a.ID, a.CategoryEpoch); e != nil {
				return e
			}
		}
		if e := s.storeCategoryReadback(ctx, a, i, fresh, "failed", "provider_refused", isNotFound(readErr)); e != nil {
			return e
		}
		return s.queueSync(ctx, s.d.DB.Pool, a.ID)
	}
	return err
}

// Recover lost wakeups and blocked work after reconnect. A retry remains a durable
// intent, including when River exhausted a readback job or a process died.
func (s *service) recoverCategoryIntents(ctx context.Context) error {
	rows, err := s.d.DB.Pool.Query(ctx, `SELECT i.workspace_id,i.account_id,i.id FROM collab_category_intents i
        JOIN collab_accounts a ON a.id = i.account_id WHERE i.state IN ('pending','confirming','blocked')
        AND NOT a.reconnect AND i.epoch = a.category_epoch AND i.updated_at < now() - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM river_job j WHERE j.kind = 'collab.apply'
            AND j.args->>'category_intent_id' = i.id::text AND j.state IN ('available','pending','running','retryable','scheduled'))
        ORDER BY i.updated_at LIMIT 100`)
	if err != nil {
		return err
	}
	type due struct{ wid, aid, id uuid.UUID }
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (due, error) { var d due; return d, r.Scan(&d.wid, &d.aid, &d.id) })
	if err != nil {
		return err
	}
	for _, d := range list {
		if err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE collab_category_intents SET state = CASE WHEN state = 'blocked' THEN 'pending' ELSE state END, updated_at = now() WHERE id = $1`, d.id); err != nil {
				return err
			}
			return s.queueCategoryIntent(ctx, tx, &accountRow{ID: d.aid, WorkspaceID: d.wid}, d.id)
		}); err != nil {
			return err
		}
	}
	_, err = s.d.DB.Pool.Exec(ctx, `DELETE FROM collab_category_intents WHERE state IN ('applied','failed','canceled') AND updated_at < now() - interval '30 days'`)
	return err
}

// OAuth reconnect wakes blocked work in the credentials transaction.
func (s *service) resumeCategoryIntents(ctx context.Context, tx pgx.Tx, wid, aid uuid.UUID) error {
	rows, err := tx.Query(ctx, `UPDATE collab_category_intents i SET state = 'pending', updated_at = now()
        FROM collab_accounts a WHERE a.id=i.account_id AND i.workspace_id=$1 AND i.account_id=$2
        AND i.epoch=a.category_epoch AND i.state='blocked' RETURNING i.id`, wid, aid)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := s.queueCategoryIntent(ctx, tx, &accountRow{ID: aid, WorkspaceID: wid}, id); err != nil {
			return err
		}
	}
	return nil
}
