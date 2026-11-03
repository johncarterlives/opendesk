package core

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Online time (contracts/api.md "Agents report"). The app's heartbeats, while a member's
// availability is online, are kept in agent_presence as stretches of time: a heartbeat
// extends the member's open stretch when the last one came less than PresenceGap ago, and
// otherwise closes it and starts a new one. A change of availability away from online ends
// the stretch. Viewers are never assigned work, so their time is not recorded. A workspace
// that turns online time off (settings agent_online_time false) records nobody's, and
// turning it off deletes what was recorded.

// PresenceGap is the longest silence between two heartbeats of one stretch. The web app
// beats every 2 minutes while a tab is visible and the iPhone app every 5 while it is open.
const PresenceGap = 10 * time.Minute

// recordPresence notes that the member is in the app now. The member row is share-locked,
// so a change of availability waits for it and the stretch never outlives the status.
func recordPresence(ctx context.Context, tx pgx.Tx, wid, uid uuid.UUID) error {
	// Serialize setting changes before reading eligibility or locking a member.
	if err := lockPresence(ctx, tx, wid, false); err != nil {
		return err
	}
	var availability, role string
	var on bool
	err := tx.QueryRow(ctx, `SELECT m.availability, m.role, `+domain.OnlineTimeSQL+`
		FROM members m JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = $1 AND m.user_id = $2 FOR SHARE OF m`,
		wid, uid).Scan(&availability, &role, &on)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !on || availability != "online" || role == "viewer" {
		return nil
	}
	tag, err := tx.Exec(ctx, `UPDATE agent_presence SET ended_at = now()
		WHERE workspace_id = $1 AND user_id = $2 AND open AND ended_at >= now() - make_interval(secs => $3)`, wid, uid, PresenceGap.Seconds())
	if err != nil || tag.RowsAffected() > 0 {
		return err
	}
	// The open stretch, if any, ended at its last heartbeat.
	if _, err := tx.Exec(ctx, `UPDATE agent_presence SET open = false WHERE workspace_id = $1 AND user_id = $2 AND open`, wid, uid); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_presence (workspace_id, user_id) VALUES ($1, $2)
		ON CONFLICT (workspace_id, user_id) WHERE open DO NOTHING`, wid, uid)
	return err
}

// removePresence deletes the workspace's online time when it turns online time off: what
// it may not record, it does not keep either.
func removePresence(ctx context.Context, tx pgx.Tx, wid uuid.UUID) error {
	// Member deletion can cascade into presence before publishing a workspace event.
	// Retry the setting transaction rather than wait for those rows under its workspace lock.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM agent_presence WHERE workspace_id=$1 FOR UPDATE NOWAIT`, wid); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM agent_presence WHERE workspace_id = $1`, wid)
	return err
}

// closePresence ends the member's open stretch when their availability leaves online. A
// member who changed it themselves was in the app until now; a change made by someone
// else ends the stretch at the member's last heartbeat.
func closePresence(ctx context.Context, tx pgx.Tx, wid, uid uuid.UUID, self bool) error {
	_, err := tx.Exec(ctx, `UPDATE agent_presence
		SET open = false, ended_at = CASE WHEN $3 AND ended_at >= now() - make_interval(secs => $4) THEN now() ELSE ended_at END
		WHERE workspace_id = $1 AND user_id = $2 AND open`, wid, uid, self, PresenceGap.Seconds())
	return err
}

// lockPresence is shared by recording/availability and exclusive for setting changes.
// Its two-key namespace is separate from the single-key trigger and event locks.
func lockPresence(ctx context.Context, tx pgx.Tx, wid uuid.UUID, exclusive bool) error {
	sql := `SELECT pg_advisory_xact_lock_shared(hashtext($1::text), 1886545267)`
	if exclusive {
		sql = `SELECT pg_advisory_xact_lock(hashtext($1::text), 1886545267)`
	}
	_, err := tx.Exec(ctx, sql, wid)
	return err
}

func (s *svc) presenceSettingsTx(ctx context.Context, write func(pgx.Tx) error) error {
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := s.tx(ctx, write)
		var pe *pgconn.PgError
		if !errors.As(err, &pe) || pe.Code != "55P03" {
			return err
		}
		if time.Now().After(deadline) {
			return httpx.Conflict("Online time is being updated. Try again.")
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
