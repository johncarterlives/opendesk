package collab

// Handling state (contracts/collab.md "Handling"): whether a person still has to act on a
// conversation, kept in opendesk apart from unread and never written to the provider. An
// account turns it on; from then on new mail from someone else needs action, a reply from
// the account (sent here or at the provider) clears it, and people mark it done or needing
// action again. Opening or reading a conversation never changes it.

import (
	"context"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Handling states of a conversation.
const (
	HandlingNeedsAction = "needs_action"
	HandlingDone        = "done"
)

// errHandlingOff is a handling change on an account that does not track it.
var errHandlingOff = httpx.Validation("Turn on handling state for the account first.")

// setHandling marks conversations the caller sees done or needing action and returns them.
func (s *service) setHandling(ctx context.Context, p *auth.Principal, ids []uuid.UUID, handling string) ([]MailThread, error) {
	if handling != HandlingNeedsAction && handling != HandlingDone {
		return nil, httpx.Validation("Unknown handling state.")
	}
	tids := appendNew(nil, ids...)
	if len(tids) == 0 || len(tids) > 100 {
		return nil, httpx.Validation("Choose 1 to 100 conversations.")
	}
	threads, err := visibleThreads(ctx, s.d.DB.Pool, p, tids)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if len(threads) != len(tids) {
		return nil, httpx.NotFound("Conversation")
	}
	byAccount := map[uuid.UUID][]uuid.UUID{}
	var order []uuid.UUID
	for _, t := range threads {
		if t.Handling == "" {
			return nil, errHandlingOff
		}
		if _, ok := byAccount[t.AccountID]; !ok {
			order = append(order, t.AccountID)
		}
		byAccount[t.AccountID] = append(byAccount[t.AccountID], t.ID)
	}
	err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		for _, aid := range order {
			list := byAccount[aid]
			changed, err := markHandling(ctx, tx, p, aid, list, handling == HandlingNeedsAction)
			if err != nil {
				return err
			}
			for _, tid := range changed {
				if err := audit.Log(ctx, tx, p, p.WorkspaceID, "collab.thread_handling", "collab_thread", &tid,
					map[string]any{"handling": handling}); err != nil {
					return err
				}
			}
			if len(changed) > 0 {
				id := aid
				if err := s.publishChanged(ctx, tx, p.WorkspaceID, &id, changed, false); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	fresh, err := visibleThreads(ctx, s.d.DB.Pool, p, tids)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	slices.SortFunc(fresh, func(x, y *threadRow) int { return slices.Index(tids, x.ID) - slices.Index(tids, y.ID) })
	out, err := threadsOut(ctx, s.d.DB.Pool, fresh)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	return out, nil
}

// markHandling sets the conversations of one account and returns those that changed.
func markHandling(ctx context.Context, tx pgx.Tx, p *auth.Principal, accountID uuid.UUID, tids []uuid.UUID, needs bool) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `UPDATE collab_threads SET needs_action = $4, handled_at = now(), handled_by = $5
		WHERE workspace_id = $1 AND account_id = $2 AND id = ANY($3) AND needs_action <> $4 RETURNING id`,
		p.WorkspaceID, accountID, tids, needs, p.UserID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// handlingTimes are the newest message from someone else (inbound) and from the account
// itself (outbound) among a conversation's messages, drafts left out; nil when none.
func handlingTimes(fromOwn []bool, sentAt []time.Time, draft []bool) (inbound, outbound *time.Time) {
	for i := range sentAt {
		if draft[i] {
			continue
		}
		t := sentAt[i]
		if fromOwn[i] {
			if outbound == nil || t.After(*outbound) {
				outbound = &t
			}
		} else if inbound == nil || t.After(*inbound) {
			inbound = &t
		}
	}
	return inbound, outbound
}

// handlingUpdateSQL is the SET clause recomputeThreads keeps handling state with: $13 is the
// newest inbound message, $14 the newest outbound. A new inbound message since the account
// turned handling on needs action; a newer reply from the account, sent after it, clears it;
// otherwise what people set stays. Mail older than handling_since (history imports) never
// needs action.
const handlingUpdateSQL = `needs_action = CASE
		WHEN $13::timestamptz IS NOT NULL AND (last_inbound_at IS NULL OR $13 > last_inbound_at)
			AND $13 >= (SELECT ha.handling_since FROM collab_accounts ha WHERE ha.id = collab_threads.account_id)
			AND ($14::timestamptz IS NULL OR $13 > $14) THEN true
		WHEN $14::timestamptz IS NOT NULL AND (last_outbound_at IS NULL OR $14 > last_outbound_at)
			AND ($13::timestamptz IS NULL OR $14 >= $13) THEN false
		ELSE needs_action END,
	last_inbound_at = $13, last_outbound_at = $14`
