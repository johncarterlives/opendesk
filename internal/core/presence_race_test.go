package core

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type presencePauseTx struct {
	pgx.Tx
	read, resume chan struct{}
}
type presencePauseRow struct {
	pgx.Row
	read, resume chan struct{}
}

func (p presencePauseTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return presencePauseRow{p.Tx.QueryRow(ctx, sql, args...), p.read, p.resume}
}
func (p presencePauseRow) Scan(v ...any) error {
	err := p.Row.Scan(v...)
	close(p.read)
	<-p.resume
	return err
}

func TestPrivacyOptOutConcurrentHeartbeat(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, _ := e.signup("privacy-race")
	wid := owner.newWorkspace("Privacy race")
	var uid uuid.UUID
	if err := e.d.DB.Pool.QueryRow(ctx, `SELECT user_id FROM members WHERE workspace_id=$1`, wid).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.DB.Pool.Exec(ctx, `UPDATE members SET availability='online' WHERE workspace_id=$1`, wid); err != nil {
		t.Fatal(err)
	}
	tx, err := e.d.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var pid int32
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	read, resume := make(chan struct{}), make(chan struct{})
	recorded := make(chan error, 1)
	go func() { recorded <- recordPresence(ctx, presencePauseTx{tx, read, resume}, uuid.MustParse(wid), uid) }()
	select {
	case <-read:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Pause the real heartbeat after reading eligibility, before it writes presence.
	updated := make(chan int, 1)
	go func() {
		r := owner.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"agent_online_time": false}})
		updated <- r.Status
	}()
	status := 0
	for {
		select {
		case status = <-updated:
		default:
		}
		if status != 0 {
			break
		}
		var blocked bool
		if err := e.d.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			close(resume)
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-ctx.Done():
			close(resume)
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	close(resume)
	if err := <-recorded; err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if status == 0 {
		select {
		case status = <-updated:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if status != 200 {
		t.Fatalf("opt-out status=%d", status)
	}
	var n int
	if err := e.d.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM agent_presence WHERE workspace_id=$1`, wid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("successful opt-out retained %d presence rows, want zero", n)
	}
}
