package core

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/routing"
	"github.com/useopendesk/opendesk/internal/httpx"
)

func TestSkillReplacementConcurrentMemberRemoval(t *testing.T) {
	for _, replacement := range []string{"empty", "old-to-new"} {
		t.Run(replacement, func(t *testing.T) {
			f := newTeamFixture(t)
			var errors bytes.Buffer
			httpx.Install(slog.New(slog.NewTextHandler(&errors, nil)))
			defer func() {
				httpx.Install(f.e.d.Log)
				if errors.Len() > 0 {
					t.Log(errors.String())
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			router := chi.NewRouter()
			resolver := &auth.Resolver{Pool: f.e.d.DB.Pool, Tokens: f.e.d.Tokens, ClientIP: httpx.ClientIP(false, 0)}
			router.Use(resolver.Middleware)
			routing.Register(f.e.d, humachi.New(router, huma.DefaultConfig("skill removal integration", "test")))
			server := httptest.NewServer(router)
			defer server.Close()
			env := *f.e
			env.srv = server
			skills := *f.owner
			skills.e = &env
			created := skills.do("POST", "/v1/skills", map[string]any{"name": "French"})
			if created.Status != 201 {
				t.Fatalf("create skill: %d %s", created.Status, created.Raw)
			}
			sid := created.str("id")
			path := "/v1/skills/" + sid + "/members"
			if r := skills.do("PUT", path, map[string]any{"member_ids": []uuid.UUID{f.agentID}}); r.Status != 200 {
				t.Fatalf("initial replacement: %d %s", r.Status, r.Raw)
			}
			requested := []uuid.UUID{}
			if replacement == "old-to-new" {
				requested = append(requested, f.otherID)
			}
			body := map[string]any{"member_ids": requested}

			gate, err := f.e.d.DB.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(context.Background())
			var gatePID int32
			if err := gate.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
				t.Fatal(err)
			}
			if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock(264005,$1)`, gatePID); err != nil {
				t.Fatal(err)
			}
			// The AFTER trigger pauses a real cascade after its row is deleted and locked.
			name := "skill_delete_gate_" + fmt.Sprint(gatePID)
			f.exec(fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(264005,%d); RETURN OLD; END $$`, name, gatePID))
			f.exec(fmt.Sprintf(`CREATE TRIGGER %s AFTER DELETE ON member_skills FOR EACH ROW WHEN (OLD.skill_id='%s'::uuid) EXECUTE FUNCTION %s()`, name, sid, name))
			t.Cleanup(func() {
				f.exec("DROP TRIGGER " + name + " ON member_skills")
				f.exec("DROP FUNCTION " + name + "()")
			})
			removed := make(chan resp, 1)
			go func() { removed <- f.owner.do("DELETE", "/v1/members/"+f.agentID.String(), nil) }()
			var removalPID int32
			for removalPID == 0 {
				if err := f.e.d.DB.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'DELETE FROM members%' LIMIT 1),0)`, gatePID).Scan(&removalPID); err != nil {
					t.Fatal(err)
				}
				if removalPID == 0 {
					select {
					case r := <-removed:
						t.Fatalf("removal missed cascade gate: %d %s", r.Status, r.Raw)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(10 * time.Millisecond):
					}
				}
			}
			t.Logf("actual member removal pid=%d blocked on cascade gate pid=%d", removalPID, gatePID)
			replaced := make(chan resp, 1)
			go func() { replaced <- skills.do("PUT", path, body) }()
			var result resp
			waitingOnRelation := false
		waitReplacement:
			for {
				select {
				case result = <-replaced:
					break waitReplacement
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(10 * time.Millisecond):
				}
				var query string
				if err := f.e.d.DB.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'DELETE FROM member_skills%' LIMIT 1),'')`, removalPID).Scan(&query); err != nil {
					t.Fatal(err)
				}
				if query != "" {
					t.Logf("replacement waits on member-removal relation: %s", query)
					waitingOnRelation = true
					break
				}
			}
			if waitingOnRelation {
				_, err := gate.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR NO KEY UPDATE NOWAIT`, f.wid)
				t.Logf("workspace probe while replacement waits on old relation: %v", err)
				if err == nil {
					t.Error("replacement did not hold workspace at relation wait")
				}
			} else {
				if _, err := gate.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR NO KEY UPDATE NOWAIT`, f.wid); err != nil {
					t.Errorf("busy replacement retained workspace lock: %v", err)
				}
				var n int
				f.scalar(`SELECT count(*) FROM member_skills WHERE workspace_id=$1 AND skill_id=$2`, &n, f.wid, sid)
				if n != 1 {
					t.Errorf("busy replacement changed committed membership: %d", n)
				}
			}
			if err := gate.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if waitingOnRelation {
				select {
				case result = <-replaced:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			var removal resp
			select {
			case removal = <-removed:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			t.Logf("replacement HTTP %d; member removal HTTP %d", result.Status, removal.Status)
			if waitingOnRelation {
				t.Error("replacement waited for a removed relation while holding workspace serialization")
			}
			if result.Status != 409 || result.str("code") != "conflict" {
				t.Errorf("busy replacement: %d %s, want typed 409", result.Status, result.Raw)
			}
			if removal.Status != 204 {
				t.Fatalf("member removal: %d %s", removal.Status, removal.Raw)
			}
			if r := skills.do("PUT", path, body); r.Status != 200 {
				t.Fatalf("replacement after removal: %d %s", r.Status, r.Raw)
			}
			var actual []uuid.UUID
			if err := f.e.d.DB.Pool.QueryRow(ctx, `SELECT ARRAY(SELECT user_id FROM member_skills WHERE workspace_id=$1 AND skill_id=$2 ORDER BY user_id)`, f.wid, sid).Scan(&actual); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(actual, requested) {
				t.Fatalf("replacement after removal: %v, want %v", actual, requested)
			}
		})
	}
}
