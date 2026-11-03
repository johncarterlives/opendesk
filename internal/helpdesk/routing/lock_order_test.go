package routing

import (
	"testing"
	"time"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestRuleWritesWaitBeforeLockingRules(t *testing.T) {
	for _, method := range []string{"PATCH", "DELETE", "reorder"} {
		t.Run(method, func(t *testing.T) {
			w := newWorld(t)
			e := w.e
			a, b := ids.New(), ids.New()
			e.Exec(`INSERT INTO routing_rules(id,workspace_id,name,team_id,position,conditions) VALUES($1,$3,'A',$4,0,'[{"field":"subject","op":"contains","value":"x"}]'),($2,$3,'B',$4,1,'[{"field":"subject","op":"contains","value":"x"}]')`, a, b, w.ws.ID, w.support)
			gate, err := e.D.DB.Pool.Begin(e.Ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(e.Ctx)
			var pid int32
			if err := gate.QueryRow(e.Ctx, `SELECT pg_backend_pid() FROM workspaces WHERE id=$1 FOR UPDATE`, w.ws.ID).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			done := make(chan *hdtest.Resp, 1)
			go func() {
				if method == "reorder" {
					done <- e.Do("POST", "/v1/routing-rules/reorder", w.admin(), map[string]any{"ids": []string{b.String(), a.String()}})
				} else {
					done <- e.Do(method, "/v1/routing-rules/"+a.String(), w.admin(), map[string]any{"name": "Edited"})
				}
			}()
			for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond * 10) {
				var blocked bool
				if err := e.D.DB.Pool.QueryRow(e.Ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("request never waited for workspace")
				}
			}
			// Another workspace-first editor can still acquire its rule while the request waits.
			_, lockErr := gate.Exec(e.Ctx, `SELECT 1 FROM routing_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE NOWAIT`, w.ws.ID, a)
			gate.Rollback(e.Ctx)
			response := <-done
			want := 200
			if method == "DELETE" {
				want = 204
			}
			response.Want(t, want)
			if lockErr != nil {
				t.Fatalf("workspace-first editor could not lock rule: %v", lockErr)
			}
		})
	}
}

func TestRuleWritesReleaseWorkspaceForRuleOwner(t *testing.T) {
	for _, method := range []string{"PATCH", "DELETE", "reorder"} {
		t.Run(method, func(t *testing.T) {
			w := newWorld(t)
			e := w.e
			a, b := ids.New(), ids.New()
			e.Exec(`INSERT INTO routing_rules(id,workspace_id,name,team_id,position,conditions) VALUES($1,$3,'A',$4,0,'[{"field":"subject","op":"contains","value":"x"}]'),($2,$3,'B',$4,1,'[{"field":"subject","op":"contains","value":"x"}]')`, a, b, w.ws.ID, w.support)
			gate, err := e.D.DB.Pool.Begin(e.Ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(e.Ctx)
			if _, err := gate.Exec(e.Ctx, `SELECT 1 FROM routing_rules WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, w.ws.ID, a); err != nil {
				t.Fatal(err)
			}
			done := make(chan *hdtest.Resp, 1)
			go func() {
				if method == "reorder" {
					done <- e.Do("POST", "/v1/routing-rules/reorder", w.admin(), map[string]any{"ids": []string{b.String(), a.String()}})
				} else {
					done <- e.Do(method, "/v1/routing-rules/"+a.String(), w.admin(), map[string]any{"name": "Edited"})
				}
			}()
			select {
			case r := <-done:
				r.Want(t, 409)
			case <-time.After(5 * time.Second):
				gate.Rollback(e.Ctx)
				(<-done).Want(t, 409)
				t.Fatal("routing writer waited for a dependency while retaining the workspace")
			}
			if _, err := gate.Exec(e.Ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR NO KEY UPDATE NOWAIT`, w.ws.ID); err != nil {
				t.Fatal(err)
			}
			gate.Rollback(e.Ctx)
			if method == "reorder" {
				e.Do("POST", "/v1/routing-rules/reorder", w.admin(), map[string]any{"ids": []string{b.String(), a.String()}}).Want(t, 200)
			} else {
				want := 200
				if method == "DELETE" {
					want = 204
				}
				e.Do(method, "/v1/routing-rules/"+a.String(), w.admin(), map[string]any{"name": "Edited"}).Want(t, want)
			}
		})
	}
}
