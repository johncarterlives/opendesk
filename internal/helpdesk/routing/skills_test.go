package routing

import (
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

type skillResponse struct {
	ID        uuid.UUID   `json:"id"`
	Name      string      `json:"name"`
	Archived  bool        `json:"archived"`
	MemberIDs []uuid.UUID `json:"member_ids"`
}

func TestSkillsAPI(t *testing.T) {
	w := newWorld(t)
	e, ad := w.e, w.admin()
	var s skillResponse
	e.Do("POST", "/v1/skills", ad, map[string]any{"name": " French "}).Want(t, 201).JSON(t, &s)
	if s.Name != "French" || s.Archived || s.MemberIDs == nil {
		t.Fatalf("skill %+v", s)
	}
	path := "/v1/skills/" + s.ID.String()
	e.Do("POST", "/v1/skills", ad, map[string]any{"name": "french"}).Want(t, 409)
	e.Do("POST", "/v1/skills", ad, map[string]any{"name": "<b>"}).Want(t, 422)
	for _, a := range []hdtest.Auth{w.ws.Agent.As(w.ws), w.ws.Viewer.As(w.ws)} {
		e.Do("GET", "/v1/skills", a, nil).Want(t, 403)
		e.Do("POST", "/v1/skills", a, map[string]any{"name": "Billing"}).Want(t, 403)
		e.Do("PATCH", path, a, map[string]any{"name": "Billing"}).Want(t, 403)
		e.Do("PUT", path+"/members", a, map[string]any{"member_ids": []uuid.UUID{}}).Want(t, 403)
	}
	read := hdtest.Auth{Bearer: e.APIKey(w.ws, auth.ScopeSettingsRead)}
	write := hdtest.Auth{Bearer: e.APIKey(w.ws, auth.ScopeSettingsWrite)}
	var list struct{ Data []skillResponse }
	e.Do("GET", "/v1/skills", read, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != s.ID {
		t.Fatalf("list %+v", list)
	}
	e.Do("PATCH", path, read, map[string]any{"name": "Billing"}).Want(t, 403)
	e.Do("POST", "/v1/skills", write, map[string]any{"name": "Billing"}).Want(t, 201)
	e.Do("PATCH", path, ad, map[string]any{"name": "billing"}).Want(t, 409)
	other := e.NewWorkspace()
	e.Do("GET", "/v1/skills", other.Admin.As(other), nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 0 {
		t.Fatal("foreign catalog visible")
	}
	e.Do("PATCH", path, other.Admin.As(other), map[string]any{"archived": true}).Want(t, 404)
	e.Do("PUT", path+"/members", other.Admin.As(other), map[string]any{"member_ids": []uuid.UUID{}}).Want(t, 404)
	suspended := e.AddUser(w.ws, auth.RoleAgent, "Suspended Agent")
	e.Exec(`UPDATE users SET suspended_at=now() WHERE id=$1`, suspended.ID)
	for _, member := range []string{other.Agent.ID.String(), w.ws.Viewer.ID.String(), suspended.ID.String(), ids.New().String(), "bad"} {
		e.Do("PUT", path+"/members", ad, map[string]any{"member_ids": []string{member}}).Want(t, 422)
	}
	e.Do("PUT", path+"/members", ad, map[string]any{"member_ids": []uuid.UUID{w.ws.Agent.ID, w.ws.Agent.ID}}).Want(t, 422)
	e.Do("PUT", path+"/members", ad, map[string]any{"member_ids": []uuid.UUID{w.ws.Owner.ID, w.ws.Admin.ID, w.ws.Agent.ID}}).Want(t, 200).JSON(t, &s)
	if len(s.MemberIDs) != 3 {
		t.Fatalf("members %+v", s)
	}
	e.Do("PUT", path+"/members", write, map[string]any{"member_ids": []uuid.UUID{w.ws.Agent.ID}}).Want(t, 200).JSON(t, &s)
	if len(s.MemberIDs) != 1 || s.MemberIDs[0] != w.ws.Agent.ID {
		t.Fatalf("replacement %+v", s)
	}
	e.Do("PUT", path+"/members", ad, map[string]any{"member_ids": []uuid.UUID{w.ws.Viewer.ID}}).Want(t, 422)
	e.Do("PATCH", path, ad, map[string]any{"name": "Francophone", "archived": true}).Want(t, 200).JSON(t, &s)
	if s.Name != "Francophone" || !s.Archived || len(s.MemberIDs) != 1 {
		t.Fatalf("archived %+v", s)
	}
	e.Do("PUT", path+"/members", ad, map[string]any{"member_ids": []uuid.UUID{}}).Want(t, 409)
	e.Do("PATCH", path, ad, map[string]any{"archived": false}).Want(t, 200)
	e.Do("PUT", path+"/members", ad, map[string]any{"member_ids": []uuid.UUID{}}).Want(t, 200).JSON(t, &s)
	if len(s.MemberIDs) != 0 {
		t.Fatalf("clear %+v", s)
	}
	types, _ := e.Events(w.ws.ID, 0)
	for _, typ := range []string{"skill.created", "skill.updated", "skill.members_updated"} {
		if !slices.Contains(types, typ) {
			t.Errorf("missing %s", typ)
		}
	}
	var audits int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND action LIKE 'skill.%'`, &audits, w.ws.ID)
	if audits != 7 {
		t.Errorf("audit count %d", audits)
	}
	var restricted int
	e.Scalar(`SELECT count(*) FROM events WHERE workspace_id=$1 AND type LIKE 'skill.%' AND user_ids @> $2::uuid[] AND cardinality(user_ids)=2`, &restricted, w.ws.ID, []uuid.UUID{w.ws.Owner.ID, w.ws.Admin.ID})
	if restricted != 7 {
		t.Errorf("admin event count %d", restricted)
	}
}

func TestSkillsArchiveRule(t *testing.T) {
	w := newWorld(t)
	e, ad := w.e, w.admin()
	var s skillResponse
	e.Do("POST", "/v1/skills", ad, map[string]any{"name": "French"}).Want(t, 201).JSON(t, &s)
	rule := ids.New()
	e.Exec(`INSERT INTO routing_rules(id,workspace_id,name,conditions,team_id) VALUES($1,$2,'French','[{"field":"channel","op":"equals","value":"email"}]',$3)`, rule, w.ws.ID, w.support)
	e.Exec(`INSERT INTO routing_rule_skills(workspace_id,routing_rule_id,skill_id) VALUES($1,$2,$3)`, w.ws.ID, rule, s.ID)
	path := "/v1/skills/" + s.ID.String()
	e.Do("PATCH", path, ad, map[string]any{"archived": true}).Want(t, 409)
	e.Exec(`UPDATE routing_rules SET enabled=false WHERE workspace_id=$1 AND id=$2`, w.ws.ID, rule)
	e.Do("PATCH", path, ad, map[string]any{"archived": true}).Want(t, 200)
}

func TestSkillsWorkspaceConstraints(t *testing.T) {
	w := newWorld(t)
	e := w.e
	other := e.NewWorkspace()
	local, foreign := ids.New(), ids.New()
	e.Exec(`INSERT INTO skills(id,workspace_id,name) VALUES($1,$2,'French'),($3,$4,'French')`, local, w.ws.ID, foreign, other.ID)
	rule := ids.New()
	e.Exec(`INSERT INTO routing_rules(id,workspace_id,name,conditions,team_id) VALUES($1,$2,'French','[{"field":"channel","op":"equals","value":"email"}]',$3)`, rule, w.ws.ID, w.support)
	checks := []struct {
		name, sql string
		args      []any
	}{
		{"foreign member", `INSERT INTO member_skills(workspace_id,user_id,skill_id) VALUES($1,$2,$3)`, []any{w.ws.ID, other.Agent.ID, local}},
		{"foreign skill", `INSERT INTO member_skills(workspace_id,user_id,skill_id) VALUES($1,$2,$3)`, []any{w.ws.ID, w.ws.Agent.ID, foreign}},
		{"foreign rule skill", `INSERT INTO routing_rule_skills(workspace_id,routing_rule_id,skill_id) VALUES($1,$2,$3)`, []any{w.ws.ID, rule, foreign}},
		{"foreign rule", `INSERT INTO routing_rule_skills(workspace_id,routing_rule_id,skill_id) VALUES($1,$2,$3)`, []any{other.ID, rule, foreign}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			_, err := e.D.DB.Pool.Exec(e.Ctx, check.sql, check.args...)
			var pe *pgconn.PgError
			if !errors.As(err, &pe) || pe.Code != "23503" {
				t.Fatalf("want foreign key rejection, got %v", err)
			}
		})
	}
	e.Exec(`INSERT INTO member_skills(workspace_id,user_id,skill_id) VALUES($1,$2,$3)`, w.ws.ID, w.ws.Agent.ID, local)
	_, err := e.D.DB.Pool.Exec(e.Ctx, `INSERT INTO member_skills(workspace_id,user_id,skill_id) VALUES($1,$2,$3)`, w.ws.ID, w.ws.Agent.ID, local)
	var pe *pgconn.PgError
	if !errors.As(err, &pe) || pe.Code != "23505" {
		t.Fatalf("want duplicate rejection, got %v", err)
	}
}
