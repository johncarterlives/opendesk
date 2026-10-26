package collab

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// The AI queue (contracts/collab.md "AI queue"): an API key with collab:draft asks for
// the next conversation that needs a reply, holds it with a claim that expires on its own,
// then saves a draft (which ends the claim) or hands it back. Only what the key's member
// sees and may act on is offered, and only on shared accounts with handling on: a
// conversation in Needs action with no draft yet (a person's or an AI's) and no live
// claim. A draft does not clear Needs action, so the conversation waits there, "AI draft
// by <key name>", until a person sends or discards it.

const (
	claimDefault = 5 * time.Minute
	claimMin     = time.Minute
	claimMax     = 15 * time.Minute
	// claimsPerMinute bounds the claims one key asks for.
	claimsPerMinute = 60
	maxSkipReason   = 500
)

var errNotAIKey = httpx.E(403, "ai_queue_keys_only", "The AI queue is for API keys with the collab:draft scope.")

// AIClaim is a conversation the caller's key holds until ExpiresAt.
type AIClaim struct {
	ConversationID uuid.UUID `json:"conversation_id"`
	ClaimedAt      time.Time `json:"claimed_at"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type aiClaimOut struct {
	Body struct {
		// Claim is nil when nothing is waiting.
		Claim        *AIClaim          `json:"claim"`
		Conversation *MailThreadDetail `json:"conversation"`
	}
}

// queueEligibleSQL is the predicate of a conversation (alias t) a key ($3) whose member is
// $2 may be offered, in workspace $1.
func queueEligibleSQL() string {
	return `t.workspace_id = $1 AND t.account_id IN ` + visibleAccountsSQL("$2") + ` AND ` + boxSQL(BoxNeedsAction, "") + `
		AND EXISTS (SELECT 1 FROM collab_accounts ha WHERE ha.id = t.account_id AND ha.visibility = 'shared' AND ha.handling_enabled)
		AND NOT EXISTS (SELECT 1 FROM collab_messages dm WHERE dm.thread_id = t.id AND dm.draft)
		AND NOT EXISTS (SELECT 1 FROM collab_ai_claims c JOIN api_keys ck ON ck.id = c.api_key_id
			WHERE c.thread_id = t.id AND c.expires_at > now() AND ck.revoked_at IS NULL)
		AND NOT EXISTS (SELECT 1 FROM collab_ai_skips sk WHERE sk.thread_id = t.id AND sk.api_key_id = $3
			AND sk.last_message_at >= t.last_message_at)`
}

func (s *service) registerQueueRoutes(api huma.API) {
	collabOp(api, huma.Operation{OperationID: "claim-collab-ai-conversation", Method: http.MethodPost, Path: "/v1/collab/ai-queue/claim",
		Summary: "Claim the next conversation for an AI key to draft"},
		func(ctx context.Context, in *struct {
			Body *struct {
				AccountID  *uuid.UUID `json:"account_id,omitempty" doc:"Only this account's conversations"`
				TTLSeconds int        `json:"ttl_seconds,omitempty" minimum:"0" maximum:"900" doc:"How long the claim holds (60 to 900; default 300)"`
			}
		}) (*aiClaimOut, error) {
			p, err := s.requireQueueKey(ctx)
			if err != nil {
				return nil, err
			}
			if !s.d.Limiter.Allow("collab-ai-claim:"+p.APIKeyID.String(), claimsPerMinute, time.Minute) {
				return nil, httpx.RateLimited()
			}
			ttl := claimDefault
			var account *uuid.UUID
			if in.Body != nil {
				if in.Body.TTLSeconds != 0 {
					ttl = min(max(time.Duration(in.Body.TTLSeconds)*time.Second, claimMin), claimMax)
				}
				account = in.Body.AccountID
			}
			if account != nil {
				if _, err := visibleAccount(ctx, s.d.DB.Pool, p, *account); err != nil {
					return nil, notFound(err, "Account")
				}
			}
			claim, err := s.claimNext(ctx, p, account, ttl)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &aiClaimOut{}
			if claim == nil {
				return out, nil
			}
			detail, err := s.threadDetail(ctx, s.d.DB.Pool, p, claim.ConversationID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out.Body.Claim, out.Body.Conversation = claim, &detail
			return out, nil
		})

	collabOp(api, huma.Operation{OperationID: "release-collab-ai-claim", Method: http.MethodPost,
		Path: "/v1/collab/ai-queue/claims/{id}/release", Summary: "Hand a claimed conversation back", DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID   string `path:"id" doc:"The conversation id"`
			Body *struct {
				Skip   bool   `json:"skip,omitempty" doc:"Do not offer it to this key again until new mail arrives"`
				Reason string `json:"reason,omitempty" maxLength:"500" doc:"Why, for example not confident; kept with the skip"`
			}
		}) (*struct{}, error) {
			p, err := s.requireQueueKey(ctx)
			if err != nil {
				return nil, err
			}
			id, err := parseID(in.ID, "Conversation")
			if err != nil {
				return nil, err
			}
			skip, reason := false, ""
			if in.Body != nil {
				skip, reason = in.Body.Skip, strings.TrimSpace(in.Body.Reason)
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var last time.Time
				err := tx.QueryRow(ctx, `DELETE FROM collab_ai_claims c USING collab_threads t
					WHERE c.thread_id = $1 AND c.api_key_id = $2 AND c.workspace_id = $3 AND c.expires_at > now() AND t.id = c.thread_id
					RETURNING t.last_message_at`, id, p.APIKeyID, p.WorkspaceID).Scan(&last)
				if err != nil {
					return err
				}
				if !skip {
					return nil
				}
				_, err = tx.Exec(ctx, `INSERT INTO collab_ai_skips (thread_id, api_key_id, workspace_id, reason, last_message_at)
					VALUES ($1, $2, $3, $4, $5)
					ON CONFLICT (thread_id, api_key_id) DO UPDATE SET reason = EXCLUDED.reason,
						last_message_at = EXCLUDED.last_message_at, created_at = now()`,
					id, p.APIKeyID, p.WorkspaceID, clipRunes(reason, maxSkipReason), last)
				return err
			})
			if err != nil {
				// No live claim of this key: expired, never claimed, or another key's.
				return nil, notFound(err, "Claim")
			}
			return nil, nil
		})
}

// requireQueueKey is requireDrafter for an API key only, with an agent's role: a person
// works their inbox and never needs the queue.
func (s *service) requireQueueKey(ctx context.Context) (*auth.Principal, error) {
	p, err := s.requireDrafter(ctx, auth.RoleAgent)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if !viaAIClient(p) {
		return nil, errNotAIKey
	}
	return p, nil
}

// claimNext claims the conversation that has waited longest among those the key may be
// offered, or returns nil. Concurrent claims skip each other's candidate rows, and the
// claim replaces only an expired one, so a conversation has one holder at a time.
func (s *service) claimNext(ctx context.Context, p *auth.Principal, account *uuid.UUID, ttl time.Duration) (*AIClaim, error) {
	var out *AIClaim
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		args := []any{p.WorkspaceID, p.UserID, p.APIKeyID}
		where := queueEligibleSQL()
		if account != nil {
			args = append(args, *account)
			where += ` AND t.account_id = $4`
		}
		var id uuid.UUID
		err := tx.QueryRow(ctx, `SELECT t.id FROM collab_threads t WHERE `+where+`
			ORDER BY t.last_message_at ASC, t.id ASC LIMIT 1 FOR UPDATE OF t SKIP LOCKED`, args...).Scan(&id)
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		var c AIClaim
		err = tx.QueryRow(ctx, `INSERT INTO collab_ai_claims (thread_id, workspace_id, api_key_id, claimed_at, expires_at)
			VALUES ($1, $2, $3, now(), now() + make_interval(secs => $4))
			ON CONFLICT (thread_id) DO UPDATE SET api_key_id = EXCLUDED.api_key_id, claimed_at = EXCLUDED.claimed_at,
				expires_at = EXCLUDED.expires_at
			WHERE collab_ai_claims.expires_at <= now()
				OR NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = collab_ai_claims.api_key_id AND k.revoked_at IS NULL)
			RETURNING thread_id, claimed_at, expires_at`, id, p.WorkspaceID, p.APIKeyID, ttl.Seconds()).Scan(&c.ConversationID, &c.ClaimedAt, &c.ExpiresAt)
		if db.IsNotFound(err) {
			return nil // claimed meanwhile; the agent asks again
		}
		if err != nil {
			return err
		}
		out = &c
		return nil
	})
	return out, err
}

// endClaims ends any claim on the conversation of a draft just saved, in tx: the key that
// held it reported back, or a person took the conversation on.
func endClaims(ctx context.Context, tx pgx.Tx, messageID uuid.UUID) error {
	_, err := tx.Exec(ctx, `DELETE FROM collab_ai_claims WHERE thread_id = (SELECT thread_id FROM collab_messages WHERE id = $1)`, messageID)
	return err
}
