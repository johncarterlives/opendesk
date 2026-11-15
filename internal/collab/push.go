package collab

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/httpx"
)

// Gmail push (contracts/collab.md "Push"): with a Pub/Sub topic configured, every Gmail
// account is watched on it, and the topic's push subscription calls gmailPushPath when the
// mailbox changes. A push queues the account's sync at once; the timer stays as it was, so
// a push that never comes costs only the wait.

const (
	gmailPushPath = "/v1/collab/google/push"
	// gmailWatchRenew is how often a watch is renewed (Gmail ends one after 7 days), and
	// gmailWatchRetry the wait after Gmail refused one.
	gmailWatchRenew = 24 * time.Hour
	gmailWatchRetry = time.Hour
	// pushFollowUp is the wait before the pass that a push during a pass asks for.
	pushFollowUp = 5 * time.Second
	googleIssuer = "https://accounts.google.com"
	googleKeys   = "https://www.googleapis.com/oauth2/v3/certs"
)

// gmailHistorySQL is the account's stored Gmail history id as a number (0 before the first
// sync), for comparing with the one Gmail pushed.
const gmailHistorySQL = `(CASE WHEN a.sync_state->>'history_id' ~ '^[0-9]{1,30}$' THEN (a.sync_state->>'history_id')::numeric ELSE 0 END)`

var defaultPushKeys = oidc.NewRemoteKeySet(context.Background(), googleKeys)

// watchGmail renews the account's watch when it is due: once a day, at once when the topic
// changed, an hour after Gmail refused one. It never fails the sync.
func (s *service) watchGmail(ctx context.Context, g *gmailProvider) {
	topic := s.d.Cfg.CollabGooglePubSubTopic
	if !s.d.Cfg.CollabGooglePush() {
		return
	}
	var watched string
	var due *time.Time
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT gmail_watch_topic, gmail_watch_at FROM collab_accounts WHERE id = $1`, g.a.ID).Scan(&watched, &due)
	if err != nil || (watched == topic && due != nil && time.Now().Before(*due)) {
		return
	}
	next := time.Now().Add(gmailWatchRenew)
	if err := g.do(ctx, http.MethodPost, "/watch", map[string]any{"topicName": topic}, nil); err != nil {
		if ctx.Err() != nil {
			return
		}
		s.log.Warn("collab gmail watch failed", "account_id", g.a.ID, "err", err)
		topic, next = watched, time.Now().Add(gmailWatchRetry)
	}
	if _, err := s.d.DB.Pool.Exec(ctx, `UPDATE collab_accounts SET gmail_watch_topic = $2, gmail_watch_at = $3 WHERE id = $1`,
		g.a.ID, topic, next); err != nil {
		s.log.Warn("collab gmail watch save failed", "account_id", g.a.ID, "err", err)
	}
}

// gmailPush is POST /v1/collab/google/push: a Pub/Sub push of a Gmail mailbox's change,
// {"message": {"data": base64 of {"emailAddress", "historyId"}}}. It answers 204 for every
// push it verified, so Pub/Sub never sends one again; a push for no account here is dropped.
func (s *service) gmailPush(w http.ResponseWriter, r *http.Request) {
	if !s.d.Cfg.CollabGooglePush() {
		httpx.WriteError(w, r, httpx.NotFound("Route"))
		return
	}
	if err := s.verifyPush(r.Context(), r.Header.Get("Authorization")); err != nil {
		httpx.WriteError(w, r, httpx.E(http.StatusUnauthorized, "unauthorized", "Invalid push token."))
		return
	}
	var body struct {
		Message struct {
			Data string `json:"data"`
		} `json:"message"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil || json.Unmarshal(raw, &body) != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Unreadable push."))
		return
	}
	var change struct {
		EmailAddress string          `json:"emailAddress"`
		HistoryID    json.RawMessage `json:"historyId"`
	}
	data, err := base64.StdEncoding.DecodeString(body.Message.Data)
	if err == nil {
		err = json.Unmarshal(data, &change)
	}
	history, ok := new(big.Int).SetString(strings.Trim(string(change.HistoryID), `"`), 10)
	if err != nil || !ok || history.Sign() <= 0 || change.EmailAddress == "" {
		w.WriteHeader(http.StatusNoContent) // nothing Pub/Sub could send better
		return
	}
	if err := s.onGmailPush(r.Context(), change.EmailAddress, history.String()); err != nil {
		s.log.Error("collab gmail push failed", "err", err)
		httpx.WriteError(w, r, httpx.E(http.StatusInternalServerError, "internal", "The push was not handled."))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// verifyPush checks the push's OIDC token: signed by Google for the push URL, as the
// configured service account.
func (s *service) verifyPush(ctx context.Context, authorization string) error {
	token, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok || token == "" {
		return errors.New("no push token")
	}
	keys := s.pushKeys
	if keys == nil {
		keys = defaultPushKeys
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	idt, err := oidc.NewVerifier(googleIssuer, keys, &oidc.Config{ClientID: s.d.Cfg.APIURL + gmailPushPath}).Verify(ctx, token)
	if err != nil {
		return err
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
	}
	if err := idt.Claims(&claims); err != nil {
		return err
	}
	if !claims.EmailVerified || !strings.EqualFold(claims.Email, s.d.Cfg.CollabGooglePubSubServiceAccount) {
		return errors.New("push from another service account")
	}
	return nil
}

// onGmailPush records the pushed history id on the mailbox's Gmail accounts and queues a
// sync of each one it is new to, unless it waits (a reconnect, its backoff, a hold) or its
// workspace lacks Collab.
func (s *service) onGmailPush(ctx context.Context, address, history string) error {
	rows, err := s.d.DB.Pool.Query(ctx, `UPDATE collab_accounts a SET gmail_push_history = GREATEST(COALESCE(a.gmail_push_history, 0), $2::numeric)
		FROM workspaces w
		WHERE w.id = a.workspace_id AND a.provider = 'google' AND lower(a.email) = lower($1)
		AND NOT a.reconnect AND NOT COALESCE((a.config->>'demo')::boolean, false)
		RETURNING a.id, a.workspace_id, `+gmailHistorySQL+` < $2::numeric
			AND COALESCE((w.settings->>'mail_enabled')::boolean, true) AND w.suspended_at IS NULL
			AND (a.next_sync_at IS NULL OR a.next_sync_at <= now())`, address, history)
	if err != nil {
		return err
	}
	type pushed struct {
		id, wid uuid.UUID
		due     bool
	}
	var list []pushed
	for rows.Next() {
		var p pushed
		if err := rows.Scan(&p.id, &p.wid, &p.due); err != nil {
			rows.Close()
			return err
		}
		list = append(list, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, p := range list {
		if !p.due {
			continue
		}
		active, err := s.collabActive(ctx, p.wid)
		if err != nil {
			return err
		}
		if active {
			if err := s.queueSync(ctx, s.d.DB.Pool, p.id); err != nil {
				return err
			}
		}
	}
	return nil
}

// storedGmailHistory is the account's stored Gmail history id, as gmailHistorySQL reads it.
func (s *service) storedGmailHistory(ctx context.Context, id uuid.UUID) string {
	var h string
	if !s.d.Cfg.CollabGooglePush() {
		return ""
	}
	_ = s.d.DB.Pool.QueryRow(ctx, `SELECT `+gmailHistorySQL+`::text FROM collab_accounts a WHERE a.id = $1 AND a.provider = 'google'`, id).Scan(&h)
	return h
}

// pushedDuring asks for another pass soon when Gmail pushed a change the pass that just
// ended did not reach. A sync queued during a pass is the same job and is not queued again,
// so the job snoozes instead. Only a pass that moved on asks, so a pass never loops.
func (s *service) pushedDuring(ctx context.Context, id uuid.UUID, before string) error {
	if before == "" {
		return nil
	}
	var again bool
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT a.status = 'active' AND NOT a.reconnect
		AND COALESCE(a.gmail_push_history, 0) > `+gmailHistorySQL+` AND `+gmailHistorySQL+` > $2::numeric
		FROM collab_accounts a WHERE a.id = $1`, id, before).Scan(&again)
	if err != nil || !again {
		return nil
	}
	return river.JobSnooze(pushFollowUp)
}
