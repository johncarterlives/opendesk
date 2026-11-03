package routing

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Skill is a workspace's named expertise, retained when archived for existing tickets.
type Skill struct {
	ID        uuid.UUID   `json:"id"`
	Name      string      `json:"name"`
	Archived  bool        `json:"archived"`
	MemberIDs []uuid.UUID `json:"member_ids"`
}

type skillBody struct {
	Name     *string `json:"name,omitempty" maxLength:"200"`
	Archived *bool   `json:"archived,omitempty"`
}

const skillSelect = `SELECT s.id, s.name, s.archived, ARRAY(SELECT ms.user_id FROM member_skills ms
 WHERE ms.workspace_id=s.workspace_id AND ms.skill_id=s.id ORDER BY ms.user_id) FROM skills s`

func scanSkill(row pgx.Row) (Skill, error) {
	var s Skill
	err := row.Scan(&s.ID, &s.Name, &s.Archived, &s.MemberIDs)
	return s, err
}

func skillChanged(ctx context.Context, tx pgx.Tx, p *auth.Principal, verb string, s Skill) error {
	if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "skill." + verb, Admins: true, Data: map[string]any{"skill": s}}); err != nil {
		return err
	}
	return audit.Log(ctx, tx, p, p.WorkspaceID, "skill."+verb, "skill", &s.ID, map[string]any{"name": s.Name, "archived": s.Archived, "member_ids": s.MemberIDs})
}

// lockSkill serializes catalog edits and member replacement, and is the lock shared
// by rule writers when checking whether a skill is available for new requirements.
func lockSkill(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID) (Skill, error) {
	// Match routing creation and event sequencing: workspace first, then skill.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR NO KEY UPDATE`, wid); err != nil {
		return Skill{}, err
	}
	s, err := scanSkill(tx.QueryRow(ctx, skillSelect+` WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF s`, wid, id))
	if db.IsNotFound(err) {
		return s, httpx.NotFound("Skill")
	}
	return s, err
}

func skillName(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID, raw string) (string, error) {
	name, err := displayname.Validate("Skill name", raw, displayname.Workspace, false)
	if err != nil {
		return "", err
	}
	// Catalog writers share the workspace lock so duplicate-name refusals stay typed.
	if _, err = tx.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR NO KEY UPDATE`, wid); err != nil {
		return "", err
	}
	var exists bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM skills WHERE workspace_id=$1 AND lower(name)=lower($2) AND id<>$3)`, wid, name, id).Scan(&exists)
	if err != nil {
		return "", err
	}
	if exists {
		return "", httpx.Conflict("A skill with this name already exists.")
	}
	return name, nil
}

func registerSkills(d *deps.Deps, api huma.API) {
	op := func(id, method, path, summary string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Tags: []string{tag}, DefaultStatus: status}
	}
	huma.Register(api, op("list-skills", http.MethodGet, "/v1/skills", "List skills", 0), func(ctx context.Context, _ *struct{}) (*struct{ Body httpx.Page[Skill] }, error) {
		p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsRead)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		rows, err := d.DB.Pool.Query(ctx, skillSelect+` WHERE s.workspace_id=$1 ORDER BY lower(s.name),s.id`, p.WorkspaceID)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		skills, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Skill, error) { return scanSkill(r) })
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		if skills == nil {
			skills = []Skill{}
		}
		return &struct{ Body httpx.Page[Skill] }{httpx.Page[Skill]{Data: skills}}, nil
	})
	huma.Register(api, op("create-skill", http.MethodPost, "/v1/skills", "Create a skill", http.StatusCreated), func(ctx context.Context, in *struct {
		Body struct {
			Name string `json:"name" maxLength:"200"`
		}
	}) (*struct{ Body Skill }, error) {
		p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		s := Skill{ID: ids.New(), MemberIDs: []uuid.UUID{}}
		err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
			var err error
			s.Name, err = skillName(ctx, tx, p.WorkspaceID, s.ID, in.Body.Name)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO skills(id,workspace_id,name) VALUES($1,$2,$3)`, s.ID, p.WorkspaceID, s.Name); err != nil {
				return err
			}
			return skillChanged(ctx, tx, p, "created", s)
		})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct{ Body Skill }{s}, nil
	})
	huma.Register(api, op("update-skill", http.MethodPatch, "/v1/skills/{id}", "Update a skill", 0), func(ctx context.Context, in *struct {
		ID   string `path:"id"`
		Body skillBody
	}) (*struct{ Body Skill }, error) {
		p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		id, err := hd.ParseID(in.ID, "Skill")
		if err != nil {
			return nil, err
		}
		var s Skill
		err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
			var err error
			s, err = lockSkill(ctx, tx, p.WorkspaceID, id)
			if err != nil {
				return err
			}
			if in.Body.Name != nil {
				s.Name, err = skillName(ctx, tx, p.WorkspaceID, id, *in.Body.Name)
				if err != nil {
					return err
				}
			}
			if in.Body.Archived != nil {
				if *in.Body.Archived {
					var used bool
					if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM routing_rule_skills rs JOIN routing_rules r ON r.workspace_id=rs.workspace_id AND r.id=rs.routing_rule_id WHERE rs.workspace_id=$1 AND rs.skill_id=$2 AND r.enabled)`, p.WorkspaceID, id).Scan(&used); err != nil {
						return err
					}
					if used {
						return httpx.Conflict("Edit enabled routing rules before archiving this skill.")
					}
				}
				s.Archived = *in.Body.Archived
			}
			if _, err = tx.Exec(ctx, `UPDATE skills SET name=$3,archived=$4 WHERE workspace_id=$1 AND id=$2`, p.WorkspaceID, id, s.Name, s.Archived); err != nil {
				return err
			}
			return skillChanged(ctx, tx, p, "updated", s)
		})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct{ Body Skill }{s}, nil
	})
	huma.Register(api, op("replace-skill-members", http.MethodPut, "/v1/skills/{id}/members", "Replace skill members", 0), func(ctx context.Context, in *struct {
		ID   string `path:"id"`
		Body struct {
			MemberIDs []string `json:"member_ids" maxItems:"1000"`
		}
	}) (*struct{ Body Skill }, error) {
		p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		id, err := hd.ParseID(in.ID, "Skill")
		if err != nil {
			return nil, err
		}
		members := make([]uuid.UUID, 0, len(in.Body.MemberIDs))
		for _, raw := range in.Body.MemberIDs {
			mid, err := uuid.Parse(strings.TrimSpace(raw))
			if err != nil || slices.Contains(members, mid) {
				return nil, httpx.Validation("member_ids must contain unique valid member ids")
			}
			members = append(members, mid)
		}
		slices.SortFunc(members, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
		var s Skill
		err = retryRoutingWrite(ctx, d.DB, func(tx pgx.Tx) error {
			// Existing member and account writers publish after their row changes.
			// Acquire both eligibility locks without waiting before workspace serialization.
			rows, err := tx.Query(ctx, `SELECT u.id FROM users u JOIN members m ON m.user_id=u.id
				WHERE m.workspace_id=$1 AND u.id=ANY($2::uuid[]) ORDER BY u.id FOR SHARE OF m,u NOWAIT`, p.WorkspaceID, members)
			if err != nil {
				return err
			}
			locked, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
			if err != nil {
				return err
			}
			if len(locked) != len(members) {
				return httpx.Validation("Skills require an active owner, admin or agent in this workspace.")
			}
			s, err = lockSkill(ctx, tx, p.WorkspaceID, id)
			if err != nil {
				return err
			}
			if s.Archived {
				return httpx.Conflict("Restore this skill before changing its members.")
			}
			for _, mid := range members {
				var eligible bool
				err = tx.QueryRow(ctx, `SELECT m.role IN ('owner','admin','agent') AND u.suspended_at IS NULL FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 FOR SHARE OF m,u`, p.WorkspaceID, mid).Scan(&eligible)
				if db.IsNotFound(err) || (err == nil && !eligible) {
					return httpx.Validation("Skills require an active owner, admin or agent in this workspace.")
				}
				if err != nil {
					return err
				}
			}
			// Member removal can hold an old relation before publishing its workspace event.
			// Lock every row DELETE will touch without waiting, including removed members.
			if _, err = tx.Exec(ctx, `SELECT 1 FROM member_skills WHERE workspace_id=$1 AND skill_id=$2 FOR UPDATE NOWAIT`, p.WorkspaceID, id); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `DELETE FROM member_skills WHERE workspace_id=$1 AND skill_id=$2`, p.WorkspaceID, id); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO member_skills(workspace_id,skill_id,user_id) SELECT $1,$2,unnest($3::uuid[])`, p.WorkspaceID, id, members); err != nil {
				return err
			}
			s.MemberIDs = members
			return skillChanged(ctx, tx, p, "members_updated", s)
		})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct{ Body Skill }{s}, nil
	})
}

// retryRoutingWrite releases every lock before retrying a busy routing dependency.
func retryRoutingWrite(ctx context.Context, database *db.DB, write func(pgx.Tx) error) error {
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := database.Tx(ctx, write)
		var pe *pgconn.PgError
		if !errors.As(err, &pe) || pe.Code != "55P03" {
			return err
		}
		if time.Now().After(deadline) {
			return httpx.Conflict("Routing settings are being updated. Try again.")
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
