package resources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// MaxTagGroups bounds the label groups of a workspace.
const MaxTagGroups = 50

// requireDefRead lets every member, and API keys that read tickets, contacts or
// settings, read label and field definitions.
func requireDefRead(ctx context.Context) (*auth.Principal, error) {
	var last error
	for _, s := range []string{auth.ScopeSettingsRead, auth.ScopeTicketsRead, auth.ScopeContactsRead} {
		p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, s)
		if err == nil {
			return p, nil
		}
		last = err
	}
	return nil, last
}

// requireDefWrite is the gate for changing definitions: admins, keys with settings:write.
func requireDefWrite(ctx context.Context) (*auth.Principal, error) {
	return auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
}

func checkColor(field, c string) (string, error) {
	c = strings.TrimSpace(c)
	if !slices.Contains(domain.LabelColors, c) {
		return "", httpx.Validation(field + " must be one of " + strings.Join(domain.LabelColors, ", "))
	}
	return c, nil
}

// cleanDescription allows 0..max characters, no markup or control characters.
func cleanDescription(s string, max int) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > max {
		return "", httpx.Validation(fmt.Sprintf("description must be %d characters or less", max))
	}
	for _, r := range s {
		if unicode.IsControl(r) || r == '<' || r == '>' {
			return "", httpx.Validation("description contains characters that are not allowed")
		}
	}
	return s, nil
}

func cleanScopes(in []string) ([]string, error) {
	out := []string{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if !slices.Contains(domain.LabelScopes, s) {
			return nil, httpx.Validation("applies_to may contain " + strings.Join(domain.LabelScopes, ", "))
		}
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil, httpx.Validation("applies_to needs at least one of " + strings.Join(domain.LabelScopes, ", "))
	}
	slices.SortFunc(out, func(a, b string) int {
		return slices.Index(domain.LabelScopes, a) - slices.Index(domain.LabelScopes, b)
	})
	return out, nil
}

// tagNameTaken reports another label with the same name, ignoring case.
func tagNameTaken(ctx context.Context, q db.Querier, wid uuid.UUID, name string, exclude *uuid.UUID) error {
	var taken bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2)
		AND ($3::uuid IS NULL OR id <> $3))`, wid, name, exclude).Scan(&taken); err != nil {
		return err
	}
	if taken {
		return httpx.Conflict("A label with this name already exists.")
	}
	return nil
}

type tagBody struct {
	Name        *string          `json:"name,omitempty" maxLength:"100"`
	Color       *string          `json:"color,omitempty" enum:"gray,red,orange,amber,yellow,lime,green,teal,cyan,blue,indigo,violet,purple,pink,rose"`
	Description *string          `json:"description,omitempty" maxLength:"300"`
	GroupID     Nullable[string] `json:"group_id,omitempty" doc:"Label group id; null ungroups"`
	Position    *int             `json:"position,omitempty" minimum:"0" maximum:"100000"`
	Archived    *bool            `json:"archived,omitempty"`
	AppliesTo   *[]string        `json:"applies_to,omitempty" maxItems:"3" doc:"tickets, contacts, companies"`
}

type tagRow struct {
	Name, Color, Description string
	GroupID                  *uuid.UUID
	Position                 int
	Archived                 bool
	AppliesTo                []string
}

func (b *tagBody) apply(ctx context.Context, q db.Querier, wid uuid.UUID, r *tagRow) error {
	if b.Name != nil {
		n, err := hd.CleanTagName(*b.Name)
		if err != nil {
			return err
		}
		r.Name = n
	}
	if r.Name == "" {
		return httpx.Validation("name is required")
	}
	if b.Color != nil {
		c, err := checkColor("color", *b.Color)
		if err != nil {
			return err
		}
		r.Color = c
	}
	if b.Description != nil {
		s, err := cleanDescription(*b.Description, 300)
		if err != nil {
			return err
		}
		r.Description = s
	}
	if b.GroupID.Set {
		if b.GroupID.Null || strings.TrimSpace(b.GroupID.Value) == "" {
			r.GroupID = nil
		} else {
			id, err := hd.ParseRef(b.GroupID.Value, "group_id")
			if err != nil {
				return err
			}
			if err := checkGroup(ctx, q, wid, id); err != nil {
				return err
			}
			r.GroupID = &id
		}
	}
	if b.Position != nil {
		r.Position = *b.Position
	}
	if b.Archived != nil {
		r.Archived = *b.Archived
	}
	if b.AppliesTo != nil {
		s, err := cleanScopes(*b.AppliesTo)
		if err != nil {
			return err
		}
		r.AppliesTo = s
	}
	return nil
}

func checkGroup(ctx context.Context, q db.Querier, wid, id uuid.UUID) error {
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tag_groups WHERE workspace_id = $1 AND id = $2)`, wid, id).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return httpx.Validation("label group not found in this workspace")
	}
	return nil
}

func tagAudit(t domain.Tag) map[string]any {
	return map[string]any{"name": t.Name, "color": t.Color, "group_id": t.GroupID, "archived": t.Archived, "applies_to": t.AppliesTo}
}

type tagOut struct{ Body domain.Tag }

// rewriteLabelRefs renames a label in automations (tag conditions, add_tag and remove_tag
// actions) and views (the label lists filters.tag and filters.tag_not), so they keep working
// after a rename or merge.
func rewriteLabelRefs(ctx context.Context, tx pgx.Tx, p *auth.Principal, from, to string) error {
	wid := p.WorkspaceID
	rows, err := tx.Query(ctx, `SELECT id, conditions, actions FROM automations WHERE workspace_id = $1 FOR UPDATE`, wid)
	if err != nil {
		return err
	}
	type auto struct {
		id         uuid.UUID
		conds      []hd.Condition
		acts       []hd.Action
		rawC, rawA []byte
	}
	var autos []auto
	for rows.Next() {
		var a auto
		if err := rows.Scan(&a.id, &a.rawC, &a.rawA); err != nil {
			rows.Close()
			return err
		}
		autos = append(autos, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, a := range autos {
		_ = json.Unmarshal(a.rawC, &a.conds)
		_ = json.Unmarshal(a.rawA, &a.acts)
		changed := false
		for i, c := range a.conds {
			if c.Field == "tag" && (c.Op == "equals" || c.Op == "not_equals") && strings.EqualFold(c.Value, from) {
				a.conds[i].Value, changed = to, true
			}
		}
		for i, ac := range a.acts {
			if (ac.Type == "add_tag" || ac.Type == "remove_tag") && strings.EqualFold(ac.Value, from) {
				a.acts[i].Value, changed = to, true
			}
		}
		if !changed {
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE automations SET conditions = $3, actions = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
			wid, a.id, a.conds, a.acts); err != nil {
			return err
		}
		au, err := scanAutomation(tx.QueryRow(ctx, automationSelect+` WHERE workspace_id = $1 AND id = $2`, wid, a.id))
		if err != nil {
			return err
		}
		if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "automation.updated", Data: map[string]any{"automation": au}}); err != nil {
			return err
		}
	}
	vrows, err := tx.Query(ctx, `SELECT id, filters FROM views WHERE workspace_id = $1 AND EXISTS (
		SELECT 1 FROM unnest(string_to_array(filters->>'tag', ',') || string_to_array(filters->>'tag_not', ',')) n
		WHERE lower(trim(n)) = lower($2)) FOR UPDATE`, wid, from)
	if err != nil {
		return err
	}
	type view struct {
		id  uuid.UUID
		raw []byte
	}
	var views []view
	for vrows.Next() {
		var v view
		if err := vrows.Scan(&v.id, &v.raw); err != nil {
			vrows.Close()
			return err
		}
		views = append(views, v)
	}
	vrows.Close()
	if err := vrows.Err(); err != nil {
		return err
	}
	for _, v := range views {
		var f map[string]any
		if json.Unmarshal(v.raw, &f) != nil {
			continue
		}
		changed := false
		for _, key := range []string{"tag", "tag_not"} {
			if list, ok := f[key].(string); ok {
				if next, hit := hd.RenameLabel(list, from, to); hit {
					f[key], changed = next, true
				}
			}
		}
		if !changed {
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE views SET filters = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`, wid, v.id, f); err != nil {
			return err
		}
		out, err := scanView(tx.QueryRow(ctx, viewSelect+` WHERE workspace_id = $1 AND id = $2`, wid, v.id))
		if err != nil {
			return err
		}
		if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: "view.updated", Data: map[string]any{"view": out}}); err != nil {
			return err
		}
	}
	return nil
}

func registerTags(d *deps.Deps, api huma.API) {
	huma.Register(api, op("list-tags", http.MethodGet, "/v1/tags", "List labels", "Labels", 0),
		func(ctx context.Context, in *struct {
			Q         string `query:"q" maxLength:"100" doc:"Name contains"`
			GroupID   string `query:"group_id" doc:"A group id, or none for ungrouped labels"`
			Archived  string `query:"archived" enum:"true,false,any," doc:"Default any"`
			AppliesTo string `query:"applies_to" enum:"tickets,contacts,companies,"`
		}) (*struct{ Body httpx.Page[domain.Tag] }, error) {
			p, err := requireDefRead(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			where := []string{"g.workspace_id = $1"}
			args := []any{p.WorkspaceID}
			add := func(clause string, v any) {
				args = append(args, v)
				where = append(where, strings.ReplaceAll(clause, "?", fmt.Sprintf("$%d", len(args))))
			}
			if q := strings.TrimSpace(in.Q); q != "" {
				add(`strpos(lower(g.name), lower(?)) > 0`, q)
			}
			switch g := strings.TrimSpace(in.GroupID); g {
			case "":
			case "none":
				where = append(where, "g.group_id IS NULL")
			default:
				id, err := hd.ParseRef(g, "group_id")
				if err != nil {
					return nil, err
				}
				add("g.group_id = ?", id)
			}
			switch in.Archived {
			case "true":
				where = append(where, "g.archived")
			case "false":
				where = append(where, "NOT g.archived")
			}
			if in.AppliesTo != "" {
				add("?::text = ANY(g.applies_to)", in.AppliesTo)
			}
			rows, err := d.DB.Pool.Query(ctx, domain.TagSelect+` WHERE `+strings.Join(where, " AND ")+domain.TagOrder, args...)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			tags, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Tag, error) { return domain.ScanTag(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[domain.Tag] }{list(tags)}, nil
		})

	huma.Register(api, op("get-tag", http.MethodGet, "/v1/tags/{id}", "Get a label", "Labels", 0),
		func(ctx context.Context, in *idPath) (*tagOut, error) {
			p, err := requireDefRead(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Label")
			if err != nil {
				return nil, err
			}
			t, err := domain.LoadTag(ctx, d.DB.Pool, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Label")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagOut{t}, nil
		})

	huma.Register(api, op("create-tag", http.MethodPost, "/v1/tags", "Create a label", "Labels", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body tagBody }) (*tagOut, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var t domain.Tag
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockKind(ctx, tx, p.WorkspaceID, "tag"); err != nil {
					return err
				}
				r := tagRow{AppliesTo: slices.Clone(domain.LabelScopes)}
				if err := in.Body.apply(ctx, tx, p.WorkspaceID, &r); err != nil {
					return err
				}
				if in.Body.Color == nil {
					r.Color = domain.DefaultLabelColor(r.Name)
				}
				if err := tagNameTaken(ctx, tx, p.WorkspaceID, r.Name, nil); err != nil {
					return err
				}
				var n int
				if err := tx.QueryRow(ctx, `SELECT count(*), COALESCE(max(position) + 1, 0) FROM tags WHERE workspace_id = $1`, p.WorkspaceID).
					Scan(&n, &r.Position); err != nil {
					return err
				}
				if n >= domain.MaxLabels {
					return httpx.Validation(fmt.Sprintf("a workspace can have at most %d labels", domain.MaxLabels))
				}
				if in.Body.Position != nil {
					r.Position = *in.Body.Position
				}
				id := ids.New()
				if _, err := tx.Exec(ctx, `INSERT INTO tags (id, workspace_id, name, color, description, group_id, position, archived, applies_to)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, p.WorkspaceID, r.Name, r.Color, r.Description, r.GroupID, r.Position,
					r.Archived, r.AppliesTo); err != nil {
					if db.IsUniqueViolation(err, "") {
						return httpx.Conflict("A label with this name already exists.")
					}
					return err
				}
				var err error
				if t, err = domain.LoadTag(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				return settingsChanged(ctx, tx, p, "tag", "created", id, map[string]any{"tag": t}, tagAudit(t))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagOut{t}, nil
		})

	huma.Register(api, op("update-tag", http.MethodPatch, "/v1/tags/{id}", "Update a label", "Labels", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body tagBody
		}) (*tagOut, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Label")
			if err != nil {
				return nil, err
			}
			var t domain.Tag
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockKind(ctx, tx, p.WorkspaceID, "tag"); err != nil {
					return err
				}
				var r tagRow
				err := tx.QueryRow(ctx, `SELECT name, color, description, group_id, position, archived, applies_to FROM tags
					WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id).
					Scan(&r.Name, &r.Color, &r.Description, &r.GroupID, &r.Position, &r.Archived, &r.AppliesTo)
				if db.IsNotFound(err) {
					return httpx.NotFound("Label")
				}
				if err != nil {
					return err
				}
				oldName := r.Name
				if err := in.Body.apply(ctx, tx, p.WorkspaceID, &r); err != nil {
					return err
				}
				if err := tagNameTaken(ctx, tx, p.WorkspaceID, r.Name, &id); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE tags SET name = $3, color = $4, description = $5, group_id = $6, position = $7,
					archived = $8, applies_to = $9, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
					p.WorkspaceID, id, r.Name, r.Color, r.Description, r.GroupID, r.Position, r.Archived, r.AppliesTo); err != nil {
					if db.IsUniqueViolation(err, "") {
						return httpx.Conflict("A label with this name already exists.")
					}
					return err
				}
				if oldName != r.Name {
					if err := rewriteLabelRefs(ctx, tx, p, oldName, r.Name); err != nil {
						return err
					}
				}
				if t, err = domain.LoadTag(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				return settingsChanged(ctx, tx, p, "tag", "updated", id, map[string]any{"tag": t}, tagAudit(t))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagOut{t}, nil
		})

	huma.Register(api, op("delete-tag", http.MethodDelete, "/v1/tags/{id}", "Delete a label", "Labels", http.StatusNoContent),
		func(ctx context.Context, in *idPath) (*struct{}, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Label")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var name string
				err := tx.QueryRow(ctx, `DELETE FROM tags WHERE workspace_id = $1 AND id = $2 RETURNING name`, p.WorkspaceID, id).Scan(&name)
				if db.IsNotFound(err) {
					return httpx.NotFound("Label")
				}
				if err != nil {
					return err
				}
				return settingsChanged(ctx, tx, p, "tag", "deleted", id, map[string]any{"tag_id": id}, map[string]any{"name": name})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})

	huma.Register(api, op("merge-tag", http.MethodPost, "/v1/tags/{id}/merge", "Merge a label into another", "Labels", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Into string `json:"into" doc:"The label that remains"`
			}
		}) (*tagOut, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			src, err := hd.ParseID(in.ID, "Label")
			if err != nil {
				return nil, err
			}
			dst, err := hd.ParseRef(in.Body.Into, "into")
			if err != nil {
				return nil, err
			}
			if src == dst {
				return nil, httpx.Validation("a label cannot be merged into itself")
			}
			var t domain.Tag
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockKind(ctx, tx, p.WorkspaceID, "tag"); err != nil {
					return err
				}
				var srcName string
				if err := tx.QueryRow(ctx, `SELECT name FROM tags WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, src).Scan(&srcName); err != nil {
					if db.IsNotFound(err) {
						return httpx.NotFound("Label")
					}
					return err
				}
				var dstName string
				var dstGroup *uuid.UUID
				var exclusive bool
				err := tx.QueryRow(ctx, `SELECT g.name, g.group_id, COALESCE(tg.exclusive, false) FROM tags g
					LEFT JOIN tag_groups tg ON tg.id = g.group_id WHERE g.workspace_id = $1 AND g.id = $2`, p.WorkspaceID, dst).
					Scan(&dstName, &dstGroup, &exclusive)
				if db.IsNotFound(err) {
					return httpx.Validation("into is not a label in this workspace")
				}
				if err != nil {
					return err
				}
				for _, k := range []domain.LabelKind{domain.TicketLabels, domain.ContactLabels, domain.CompanyLabels} {
					if exclusive {
						// The merged label replaces the others of its exclusive group on the records it reaches.
						if _, err := tx.Exec(ctx, `DELETE FROM `+k.Table+` x USING tags g
							WHERE x.tag_id = g.id AND g.workspace_id = $1 AND g.group_id = $2 AND g.id <> $3 AND g.id <> $4
							AND x.`+k.Col+` IN (SELECT `+k.Col+` FROM `+k.Table+` WHERE tag_id = $4)`, p.WorkspaceID, *dstGroup, dst, src); err != nil {
							return err
						}
					}
					if _, err := tx.Exec(ctx, `INSERT INTO `+k.Table+` (`+k.Col+`, tag_id) SELECT `+k.Col+`, $2 FROM `+k.Table+` WHERE tag_id = $1
						ON CONFLICT DO NOTHING`, src, dst); err != nil {
						return err
					}
				}
				if _, err := tx.Exec(ctx, `DELETE FROM tags WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, src); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE tags SET updated_at = now() WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, dst); err != nil {
					return err
				}
				if err := rewriteLabelRefs(ctx, tx, p, srcName, dstName); err != nil {
					return err
				}
				if t, err = domain.LoadTag(ctx, tx, p.WorkspaceID, dst); err != nil {
					return err
				}
				return settingsChanged(ctx, tx, p, "tag", "merged", src, map[string]any{"tag_id": src, "into": t},
					map[string]any{"name": srcName, "into": dst, "into_name": dstName})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagOut{t}, nil
		})

	huma.Register(api, op("reorder-tags", http.MethodPost, "/v1/tags/reorder", "Reorder labels", "Labels", 0),
		func(ctx context.Context, in *struct{ Body reorderBody }) (*struct{ Body httpx.Page[domain.Tag] }, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out []domain.Tag
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				moved, err := reorder(ctx, tx, p.WorkspaceID, "tags", "", nil, in.Body.IDs, "label")
				if err != nil {
					return err
				}
				for _, id := range moved {
					t, err := domain.LoadTag(ctx, tx, p.WorkspaceID, id)
					if err != nil {
						return err
					}
					if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "tag.updated", Data: map[string]any{"tag": t}}); err != nil {
						return err
					}
				}
				if len(moved) > 0 {
					if err := auditReorder(ctx, tx, p, "tag", len(moved)); err != nil {
						return err
					}
				}
				rows, err := tx.Query(ctx, domain.TagSelect+` WHERE g.workspace_id = $1`+domain.TagOrder, p.WorkspaceID)
				if err != nil {
					return err
				}
				out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Tag, error) { return domain.ScanTag(r) })
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[domain.Tag] }{list(out)}, nil
		})
}

type reorderBody struct {
	IDs []string `json:"ids" minItems:"1" maxItems:"1000"`
}

// reorder sets position = index for ids in table (a trusted constant), all of which must
// be the workspace's rows (and, with scopeCol, match scopeVal). It returns the moved ids.
func reorder(ctx context.Context, tx pgx.Tx, wid uuid.UUID, table, scopeCol string, scopeVal any, raw []string, what string) ([]uuid.UUID, error) {
	list := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		id, err := hd.ParseRef(s, "ids")
		if err != nil {
			return nil, err
		}
		if slices.Contains(list, id) {
			return nil, httpx.Validation("ids must not repeat")
		}
		list = append(list, id)
	}
	q := `SELECT id, position FROM ` + table + ` WHERE workspace_id = $1 AND id = ANY($2)`
	args := []any{wid, list}
	if scopeCol != "" {
		q += ` AND ` + scopeCol + ` = $3`
		args = append(args, scopeVal)
	}
	rows, err := tx.Query(ctx, q+` FOR UPDATE`, args...)
	if err != nil {
		return nil, err
	}
	pos := map[uuid.UUID]int{}
	for rows.Next() {
		var id uuid.UUID
		var p int
		if err := rows.Scan(&id, &p); err != nil {
			rows.Close()
			return nil, err
		}
		pos[id] = p
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(pos) != len(list) {
		return nil, httpx.Validation("ids must all be " + what + "s of this workspace")
	}
	var moved []uuid.UUID
	for i, id := range list {
		if pos[id] == i {
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE `+table+` SET position = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`, wid, id, i); err != nil {
			return nil, err
		}
		moved = append(moved, id)
	}
	return moved, nil
}

func auditReorder(ctx context.Context, tx pgx.Tx, p *auth.Principal, kind string, n int) error {
	return auditLog(ctx, tx, p, kind+".reordered", kind, nil, map[string]any{"moved": n})
}

// --- Label groups -------------------------------------------------------------------

type tagGroupBody struct {
	Name      *string          `json:"name,omitempty" maxLength:"100"`
	Color     Nullable[string] `json:"color,omitempty" doc:"A palette colour, or null for none"`
	Exclusive *bool            `json:"exclusive,omitempty" doc:"At most one label of the group per record"`
	Position  *int             `json:"position,omitempty" minimum:"0" maximum:"100000"`
}

func (b *tagGroupBody) apply(g *domain.TagGroup) error {
	if b.Name != nil {
		n, err := cleanName("name", *b.Name, 50)
		if err != nil {
			return err
		}
		g.Name = n
	}
	if g.Name == "" {
		return httpx.Validation("name is required")
	}
	if b.Color.Set {
		if b.Color.Null || strings.TrimSpace(b.Color.Value) == "" {
			g.Color = nil
		} else {
			c, err := checkColor("color", b.Color.Value)
			if err != nil {
				return err
			}
			g.Color = &c
		}
	}
	if b.Exclusive != nil {
		g.Exclusive = *b.Exclusive
	}
	if b.Position != nil {
		g.Position = *b.Position
	}
	return nil
}

func groupAudit(g domain.TagGroup) map[string]any {
	return map[string]any{"name": g.Name, "color": g.Color, "exclusive": g.Exclusive}
}

type tagGroupOut struct{ Body domain.TagGroup }

func groupNameTaken(ctx context.Context, q db.Querier, wid uuid.UUID, name string, exclude *uuid.UUID) error {
	var taken bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tag_groups WHERE workspace_id = $1 AND lower(name) = lower($2)
		AND ($3::uuid IS NULL OR id <> $3))`, wid, name, exclude).Scan(&taken); err != nil {
		return err
	}
	if taken {
		return httpx.Conflict("A label group with this name already exists.")
	}
	return nil
}

func registerTagGroups(d *deps.Deps, api huma.API) {
	const order = ` ORDER BY tg.position, lower(tg.name), tg.id`
	huma.Register(api, op("list-tag-groups", http.MethodGet, "/v1/tag-groups", "List label groups", "Labels", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body httpx.Page[domain.TagGroup] }, error) {
			p, err := requireDefRead(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, domain.TagGroupSelect+` WHERE tg.workspace_id = $1`+order, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.TagGroup, error) { return domain.ScanTagGroup(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[domain.TagGroup] }{list(out)}, nil
		})

	huma.Register(api, op("get-tag-group", http.MethodGet, "/v1/tag-groups/{id}", "Get a label group", "Labels", 0),
		func(ctx context.Context, in *idPath) (*tagGroupOut, error) {
			p, err := requireDefRead(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Label group")
			if err != nil {
				return nil, err
			}
			g, err := domain.LoadTagGroup(ctx, d.DB.Pool, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Label group")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagGroupOut{g}, nil
		})

	huma.Register(api, op("create-tag-group", http.MethodPost, "/v1/tag-groups", "Create a label group", "Labels", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body tagGroupBody }) (*tagGroupOut, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var g domain.TagGroup
			if err := in.Body.apply(&g); err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockKind(ctx, tx, p.WorkspaceID, "tag_group"); err != nil {
					return err
				}
				if err := groupNameTaken(ctx, tx, p.WorkspaceID, g.Name, nil); err != nil {
					return err
				}
				var n, next int
				if err := tx.QueryRow(ctx, `SELECT count(*), COALESCE(max(position) + 1, 0) FROM tag_groups WHERE workspace_id = $1`,
					p.WorkspaceID).Scan(&n, &next); err != nil {
					return err
				}
				if n >= MaxTagGroups {
					return httpx.Validation(fmt.Sprintf("a workspace can have at most %d label groups", MaxTagGroups))
				}
				if in.Body.Position == nil {
					g.Position = next
				}
				id := ids.New()
				if _, err := tx.Exec(ctx, `INSERT INTO tag_groups (id, workspace_id, name, color, exclusive, position) VALUES ($1,$2,$3,$4,$5,$6)`,
					id, p.WorkspaceID, g.Name, g.Color, g.Exclusive, g.Position); err != nil {
					return err
				}
				var err error
				if g, err = domain.LoadTagGroup(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				return settingsChanged(ctx, tx, p, "tag_group", "created", id, map[string]any{"tag_group": g}, groupAudit(g))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagGroupOut{g}, nil
		})

	huma.Register(api, op("update-tag-group", http.MethodPatch, "/v1/tag-groups/{id}", "Update a label group", "Labels", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body tagGroupBody
		}) (*tagGroupOut, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Label group")
			if err != nil {
				return nil, err
			}
			var g domain.TagGroup
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := lockKind(ctx, tx, p.WorkspaceID, "tag_group"); err != nil {
					return err
				}
				var err error
				g, err = domain.LoadTagGroup(ctx, tx, p.WorkspaceID, id)
				if db.IsNotFound(err) {
					return httpx.NotFound("Label group")
				}
				if err != nil {
					return err
				}
				if err := in.Body.apply(&g); err != nil {
					return err
				}
				if err := groupNameTaken(ctx, tx, p.WorkspaceID, g.Name, &id); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE tag_groups SET name = $3, color = $4, exclusive = $5, position = $6, updated_at = now()
					WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, g.Name, g.Color, g.Exclusive, g.Position); err != nil {
					return err
				}
				if g, err = domain.LoadTagGroup(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				return settingsChanged(ctx, tx, p, "tag_group", "updated", id, map[string]any{"tag_group": g}, groupAudit(g))
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &tagGroupOut{g}, nil
		})

	huma.Register(api, op("delete-tag-group", http.MethodDelete, "/v1/tag-groups/{id}", "Delete a label group", "Labels", http.StatusNoContent),
		func(ctx context.Context, in *idPath) (*struct{}, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Label group")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				// Its labels become ungrouped; publish them so pickers regroup.
				rows, err := tx.Query(ctx, `UPDATE tags SET group_id = NULL, updated_at = now() WHERE workspace_id = $1 AND group_id = $2 RETURNING id`,
					p.WorkspaceID, id)
				if err != nil {
					return err
				}
				moved, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
				if err != nil {
					return err
				}
				var name string
				err = tx.QueryRow(ctx, `DELETE FROM tag_groups WHERE workspace_id = $1 AND id = $2 RETURNING name`, p.WorkspaceID, id).Scan(&name)
				if db.IsNotFound(err) {
					return httpx.NotFound("Label group")
				}
				if err != nil {
					return err
				}
				for _, tid := range moved {
					t, err := domain.LoadTag(ctx, tx, p.WorkspaceID, tid)
					if err != nil {
						return err
					}
					if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "tag.updated", Data: map[string]any{"tag": t}}); err != nil {
						return err
					}
				}
				return settingsChanged(ctx, tx, p, "tag_group", "deleted", id, map[string]any{"tag_group_id": id}, map[string]any{"name": name})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})

	huma.Register(api, op("reorder-tag-groups", http.MethodPost, "/v1/tag-groups/reorder", "Reorder label groups", "Labels", 0),
		func(ctx context.Context, in *struct{ Body reorderBody }) (*struct{ Body httpx.Page[domain.TagGroup] }, error) {
			p, err := requireDefWrite(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var out []domain.TagGroup
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				moved, err := reorder(ctx, tx, p.WorkspaceID, "tag_groups", "", nil, in.Body.IDs, "label group")
				if err != nil {
					return err
				}
				for _, id := range moved {
					g, err := domain.LoadTagGroup(ctx, tx, p.WorkspaceID, id)
					if err != nil {
						return err
					}
					if _, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "tag_group.updated", Data: map[string]any{"tag_group": g}}); err != nil {
						return err
					}
				}
				if len(moved) > 0 {
					if err := auditReorder(ctx, tx, p, "tag_group", len(moved)); err != nil {
						return err
					}
				}
				rows, err := tx.Query(ctx, domain.TagGroupSelect+` WHERE tg.workspace_id = $1`+order, p.WorkspaceID)
				if err != nil {
					return err
				}
				out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.TagGroup, error) { return domain.ScanTagGroup(r) })
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[domain.TagGroup] }{list(out)}, nil
		})
}

func auditLog(ctx context.Context, tx pgx.Tx, p *auth.Principal, action, entityType string, id *uuid.UUID, data map[string]any) error {
	return audit.Log(ctx, tx, p, p.WorkspaceID, action, entityType, id, data)
}
