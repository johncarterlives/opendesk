package core

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"strings"
	"testing"
	"time"
)

type presenceLockPauseTx struct {
	pgx.Tx
	locked, resume chan struct{}
}

func (p presenceLockPauseTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tag, err := p.Tx.Exec(ctx, sql, args...)
	if err == nil && (strings.Contains(sql, "pg_advisory_xact_lock_shared") || (strings.Contains(sql, "FROM workspaces") && strings.Contains(sql, "FOR SHARE"))) {
		close(p.locked)
		select {
		case <-p.resume:
		case <-ctx.Done():
			return tag, ctx.Err()
		}
	}
	return tag, err
}
func waitPresenceBlocked(t *testing.T, ctx context.Context, e *testEnv, pid int32, want int) {
	t.Helper()
	for {
		var n int
		if err := e.d.DB.Pool.QueryRow(ctx, `WITH RECURSIVE blocked(pid) AS (
 SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
 UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
 ) SELECT count(*) FROM blocked`, pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n >= want {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestPrivacyOptOutBeforeAvailabilityLocksMember(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	owner, email := e.signup("privacy-availability")
	wid := uuid.MustParse(owner.newWorkspace("Privacy availability"))
	uid := e.userID(email)
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
	locked, resume := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	}()
	beat := make(chan error, 1)
	go func() {
		err := recordPresence(ctx, presenceLockPauseTx{tx, locked, resume}, wid, uid)
		if err == nil {
			err = tx.Commit(ctx)
		}
		beat <- err
	}()
	select {
	case <-locked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	optout := make(chan resp, 1)
	go func() {
		optout <- owner.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"agent_online_time": false}})
	}()
	waitPresenceBlocked(t, ctx, e, pid, 1)
	availability := make(chan resp, 1)
	go func() {
		availability <- owner.do("PATCH", "/v1/members/me/availability", map[string]any{"availability": "online"})
	}()
	waitPresenceBlocked(t, ctx, e, pid, 2)
	close(resume)
	if err := <-beat; err != nil {
		t.Fatal(err)
	}
	for name, ch := range map[string]<-chan resp{"opt-out": optout, "availability": availability} {
		select {
		case r := <-ch:
			if r.Status != 200 {
				t.Fatalf("%s: %d %s", name, r.Status, r.Raw)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var n int
	if err := e.d.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM agent_presence WHERE workspace_id=$1`, wid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("successful opt-out retained %d rows", n)
	}
}

func TestPrivacyOptOutDuringMemberRemoval(t *testing.T) {
	f := newTeamFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	f.exec(`INSERT INTO agent_presence(workspace_id,user_id) VALUES($1,$2)`, f.wid, f.agentID)
	gate, err := f.e.d.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(context.Background())
	var pid int32
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('presence-delete-test:' || $1::text,0))`, f.wid); err != nil {
		t.Fatal(err)
	}
	if err := gate.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	name := "presence_delete_" + strings.ReplaceAll(f.wid.String(), "-", "")
	function := pgx.Identifier{name}.Sanitize()
	f.exec(fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('presence-delete-test:' || OLD.workspace_id::text,0)); RETURN OLD; END $$`, function))
	f.exec(fmt.Sprintf(`CREATE TRIGGER %s AFTER DELETE ON agent_presence FOR EACH ROW WHEN (OLD.workspace_id='%s'::uuid) EXECUTE FUNCTION %s()`, function, f.wid, function))
	t.Cleanup(func() {
		f.exec("DROP TRIGGER " + function + " ON agent_presence")
		f.exec("DROP FUNCTION " + function + "()")
	})
	removed := make(chan resp, 1)
	go func() { removed <- f.owner.do("DELETE", "/v1/members/"+f.agentID.String(), nil) }()
	waitPresenceBlocked(t, ctx, f.e, pid, 1)
	optout := make(chan resp, 1)
	go func() {
		optout <- f.owner.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"agent_online_time": false}})
	}()
	var early *resp
	for early == nil {
		select {
		case r := <-optout:
			early = &r
		default:
		}
		if early != nil {
			break
		}
		var n int
		if err := f.e.d.DB.Pool.QueryRow(ctx, `WITH RECURSIVE blocked(pid) AS (
 SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
 UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
 ) SELECT count(*) FROM blocked`, pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n >= 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	gate.Rollback(context.Background())
	select {
	case r := <-removed:
		if r.Status != 204 {
			t.Fatalf("removal: %d %s", r.Status, r.Raw)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if early == nil {
		select {
		case r := <-optout:
			early = &r
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if early.Status != 200 && early.Status != 409 {
		t.Fatalf("opt-out: %d %s", early.Status, early.Raw)
	}
	if r := f.owner.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"agent_online_time": false}}); r.Status != 200 {
		t.Fatalf("retry opt-out: %d %s", r.Status, r.Raw)
	}
	var n int
	f.scalar(`SELECT count(*) FROM agent_presence WHERE workspace_id=$1`, &n, f.wid)
	if n != 0 {
		t.Fatalf("successful opt-out retained %d rows", n)
	}
	f.scalar(`SELECT count(*) FROM members WHERE workspace_id=$1 AND user_id=$2`, &n, f.wid, f.agentID)
	if n != 0 {
		t.Fatal("member removal did not commit")
	}
}
