package routing

import (
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"testing"
	"time"
)

func TestSkillMembersBusyEligibilityLeavesWorkspaceAvailable(t *testing.T) {
	for _, table := range []string{"users", "members"} {
		t.Run(table, func(t *testing.T) {
			w := newWorld(t)
			e := w.e
			var skill skillResponse
			e.Do("POST", "/v1/skills", w.admin(), map[string]any{"name": "French"}).Want(t, 201).JSON(t, &skill)
			gate, err := e.D.DB.Pool.Begin(e.Ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(e.Ctx)
			query := `SELECT 1 FROM users WHERE id=$1 FOR UPDATE`
			if table == "members" {
				query = `SELECT 1 FROM members WHERE user_id=$1 AND workspace_id=$2 FOR UPDATE`
			}
			args := []any{w.ws.Agent.ID}
			if table == "members" {
				args = append(args, w.ws.ID)
			}
			if _, err := gate.Exec(e.Ctx, query, args...); err != nil {
				t.Fatal(err)
			}
			done := make(chan *hdtest.Resp, 1)
			path := "/v1/skills/" + skill.ID.String() + "/members"
			body := map[string]any{"member_ids": []string{w.ws.Agent.ID.String()}}
			go func() { done <- e.Do("PUT", path, w.admin(), body) }()
			select {
			case r := <-done:
				r.Want(t, 409)
			case <-time.After(5 * time.Second):
				gate.Rollback(e.Ctx)
				(<-done).Want(t, 409)
				t.Fatal("busy eligibility must release locks and return a typed conflict")
			}
			if _, err := gate.Exec(e.Ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT`, w.ws.ID); err != nil {
				t.Fatal(err)
			}
			var n int
			e.Scalar(`SELECT count(*) FROM member_skills WHERE workspace_id=$1 AND skill_id=$2`, &n, w.ws.ID, skill.ID)
			if n != 0 {
				t.Fatalf("partial replacement: %d", n)
			}
			gate.Rollback(e.Ctx)
			e.Do("PUT", path, w.admin(), body).Want(t, 200).JSON(t, &skill)
			if len(skill.MemberIDs) != 1 || skill.MemberIDs[0] != w.ws.Agent.ID {
				t.Fatalf("replacement: %+v", skill)
			}
		})
	}
}
