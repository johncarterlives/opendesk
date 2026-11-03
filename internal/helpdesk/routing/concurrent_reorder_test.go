package routing

import (
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
	"testing"
	"time"
)

func TestRuleUpdateConcurrentReorder(t *testing.T) {
	e := hdtest.New(t)
	ws := e.NewWorkspace()
	team, a, b := ids.New(), ids.New(), ids.New()
	e.Exec(`INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'Audit')`, team, ws.ID)
	e.Exec(`INSERT INTO routing_rules(id,workspace_id,name,team_id,position,conditions) VALUES($1,$3,'A',$4,0,'[{"field":"subject","op":"contains","value":"x"}]'),($2,$3,'B',$4,1,'[{"field":"subject","op":"contains","value":"x"}]')`, a, b, ws.ID, team)
	update, err := e.D.DB.Pool.Begin(e.Ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer update.Rollback(e.Ctx)
	order, err := e.D.DB.Pool.Begin(e.Ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer order.Rollback(e.Ctx)
	var upid, opid int32
	if err := update.QueryRow(e.Ctx, `SELECT pg_backend_pid()`).Scan(&upid); err != nil {
		t.Fatal(err)
	}
	if err := order.QueryRow(e.Ctx, `SELECT pg_backend_pid()`).Scan(&opid); err != nil {
		t.Fatal(err)
	}
	// First operation in the actual PATCH route.
	if _, err := update.Exec(e.Ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, ws.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := reorder(e.Ctx, order, &auth.Principal{Kind: auth.KindUser, UserID: ws.Owner.ID, WorkspaceID: ws.ID, Role: auth.RoleOwner}, []string{b.String(), a.String()})
		result <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var blocked bool
		if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT $1=ANY(pg_blocking_pids($2))`, upid, opid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("reorder did not reach workspace lock")
		}
	}
	// Next operation in the actual PATCH route, after its workspace lock.
	_, updateErr := loadRule(e.Ctx, update, ws.ID, a, true)
	update.Rollback(e.Ctx) // Release it if the other transaction was chosen as the victim.
	reorderErr := <-result
	t.Logf("PATCH loadRule error=%v; reorder error=%v", updateErr, reorderErr)
	if updateErr != nil || reorderErr != nil {
		t.Fatalf("concurrent rule update/reorder must succeed, got update=%v reorder=%v", updateErr, reorderErr)
	}
}
