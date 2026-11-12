package contacts

import (
	"context"
	"net/http"
	"strconv"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// maxBulkQuery bounds how many records one request that names its records by a filter acts on.
// Each record is audited and announced, so a larger selection is split by narrowing the filter.
const maxBulkQuery = 1000

type bulkResult struct {
	Updated int `json:"updated"`
	Deleted int `json:"deleted"`
}

type contactBulkPatch struct {
	AddTags    []string         `json:"add_tags,omitempty" maxItems:"50" doc:"Adds these labels, by name"`
	RemoveTags []string         `json:"remove_tags,omitempty" maxItems:"50" doc:"Removes these labels, by name"`
	CompanyID  Nullable[string] `json:"company_id,omitempty" doc:"Company id; null clears it"`
	Fields     map[string]any   `json:"fields,omitempty" doc:"Custom field values by key, merged; null clears a field"`
}

type contactBulkBody struct {
	IDs    []string          `json:"ids,omitempty" maxItems:"100"`
	Query  *contactFilter    `json:"query,omitempty" doc:"The People list's filters, instead of ids"`
	Patch  *contactBulkPatch `json:"patch,omitempty"`
	Delete bool              `json:"delete,omitempty"`
}

type companyBulkPatch struct {
	AddTags    []string       `json:"add_tags,omitempty" maxItems:"50" doc:"Adds these labels, by name"`
	RemoveTags []string       `json:"remove_tags,omitempty" maxItems:"50" doc:"Removes these labels, by name"`
	Fields     map[string]any `json:"fields,omitempty" doc:"Custom field values by key, merged; null clears a field"`
}

type companyBulkBody struct {
	IDs    []string          `json:"ids,omitempty" maxItems:"100"`
	Query  *companyFilter    `json:"query,omitempty" doc:"The Companies list's filters, instead of ids"`
	Patch  *companyBulkPatch `json:"patch,omitempty"`
	Delete bool              `json:"delete,omitempty"`
}

// bulkShape checks the request names its records one way and asks for one thing.
func bulkShape(ids int, query, patch, del, empty bool) error {
	if patch == del {
		return httpx.Validation("send either patch or delete: true")
	}
	if (ids == 0) == !query {
		return httpx.Validation("send either ids or query")
	}
	if patch && empty {
		return httpx.Validation("the patch changes nothing")
	}
	return nil
}

// workspaceIDs resolves the ids the request named, refusing any that is not in the workspace.
func workspaceIDs(ctx context.Context, tx pgx.Tx, table, what string, wid uuid.UUID, raw []string) ([]uuid.UUID, error) {
	seen := map[uuid.UUID]bool{}
	var want []uuid.UUID
	for _, r := range raw {
		id, err := hd.ParseID(r, what)
		if err != nil {
			return nil, err
		}
		if !seen[id] {
			seen[id] = true
			want = append(want, id)
		}
	}
	rows, err := tx.Query(ctx, `SELECT id FROM `+table+` WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id`, wid, want)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	if len(found) != len(want) {
		return nil, httpx.NotFound(what)
	}
	return found, nil
}

// idsWhere selects the ids a list's filter matches, at most maxBulkQuery of them.
func idsWhere(ctx context.Context, tx pgx.Tx, from, where string, args []any) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM `+from+where+` ORDER BY id LIMIT `+strconv.Itoa(maxBulkQuery+1), args...)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	if len(ids) > maxBulkQuery {
		return nil, httpx.E(422, "too_many_records", "That filter matches more than 1000 records. Narrow it and try again.")
	}
	return ids, nil
}

// fieldsPatch merges one patch into many records' custom fields, checked against the entity's
// definitions as each record's own PATCH is.
type fieldsPatch struct {
	table  string
	patch  map[string]any
	defs   domain.FieldDefs
	member domain.MemberCheck
}

func newFieldsPatch(ctx context.Context, tx pgx.Tx, wid uuid.UUID, table, entity string, patch map[string]any) (*fieldsPatch, error) {
	if len(patch) == 0 {
		return nil, nil
	}
	defs, err := domain.LoadFieldDefs(ctx, tx, wid, entity)
	if err != nil {
		return nil, err
	}
	return &fieldsPatch{table: table, patch: patch, defs: defs, member: domain.MemberChecker(ctx, tx, wid)}, nil
}

func (f *fieldsPatch) apply(ctx context.Context, tx pgx.Tx, wid, id uuid.UUID) error {
	if f == nil {
		return nil
	}
	var cur map[string]any
	if err := tx.QueryRow(ctx, `SELECT fields FROM `+f.table+` WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, wid, id).Scan(&cur); err != nil {
		return err
	}
	if cur == nil {
		cur = map[string]any{}
	}
	next, _, err := domain.MergeFields(f.defs, cur, f.patch, f.member)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE `+f.table+` SET fields = $3 WHERE workspace_id = $1 AND id = $2`, wid, id, next)
	return err
}

// bulkUpdated stamps, audits and announces one record a bulk patch changed.
func bulkUpdated(ctx context.Context, tx pgx.Tx, p *auth.Principal, table, entity string, id uuid.UUID, load func() (any, error)) error {
	if _, err := tx.Exec(ctx, `UPDATE `+table+` SET updated_at = now() WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id); err != nil {
		return err
	}
	rec, err := load()
	if err != nil {
		return err
	}
	if err := audit.Log(ctx, tx, p, p.WorkspaceID, entity+".updated", entity, &id, map[string]any{"bulk": true}); err != nil {
		return err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: entity + ".updated", Data: map[string]any{entity: rec}})
	return err
}

func registerBulk(d *deps.Deps, api huma.API) {
	huma.Register(api, op("bulk-contacts", http.MethodPost, "/v1/contacts/bulk", "Update or delete many contacts", "Contacts", 0),
		func(ctx context.Context, in *struct{ Body contactBulkBody }) (*struct{ Body bulkResult }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			empty := b.Patch != nil && len(b.Patch.AddTags) == 0 && len(b.Patch.RemoveTags) == 0 && !b.Patch.CompanyID.Set && len(b.Patch.Fields) == 0
			if err := bulkShape(len(b.IDs), b.Query != nil, b.Patch != nil, b.Delete, empty); err != nil {
				return nil, err
			}
			var out bulkResult
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var ids []uuid.UUID
				var err error
				if b.Query != nil {
					where, args, err := b.Query.where(ctx, tx, p)
					if err != nil {
						return err
					}
					ids, err = idsWhere(ctx, tx, "contacts ct", where, args)
					if err != nil {
						return err
					}
				} else if ids, err = workspaceIDs(ctx, tx, "contacts", "Contact", p.WorkspaceID, b.IDs); err != nil {
					return err
				}
				if b.Delete {
					for _, id := range ids {
						if err := deleteContact(ctx, tx, p, id, map[string]any{"bulk": true}); err != nil {
							return err
						}
					}
					out.Deleted = len(ids)
					return nil
				}
				var company *uuid.UUID
				if b.Patch.CompanyID.Set && !b.Patch.CompanyID.Null {
					id, err := hd.ParseRef(b.Patch.CompanyID.Value, "company_id")
					if err != nil {
						return err
					}
					if err := hd.CheckRef(ctx, tx, p.WorkspaceID, "company", id); err != nil {
						return err
					}
					company = &id
				}
				fields, err := newFieldsPatch(ctx, tx, p.WorkspaceID, "contacts", domain.FieldEntityContact, b.Patch.Fields)
				if err != nil {
					return err
				}
				for _, id := range ids {
					if err := applyLabels(ctx, tx, p, domain.ContactLabels, id, nil, b.Patch.AddTags, b.Patch.RemoveTags); err != nil {
						return err
					}
					if b.Patch.CompanyID.Set {
						if _, err := tx.Exec(ctx, `UPDATE contacts SET company_id = $3 WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, company); err != nil {
							return err
						}
					}
					if err := fields.apply(ctx, tx, p.WorkspaceID, id); err != nil {
						return err
					}
					if err := bulkUpdated(ctx, tx, p, "contacts", "contact", id, func() (any, error) { return domain.LoadContact(ctx, tx, p.WorkspaceID, id) }); err != nil {
						return err
					}
				}
				out.Updated = len(ids)
				return nil
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body bulkResult }{out}, nil
		})

	huma.Register(api, op("bulk-companies", http.MethodPost, "/v1/companies/bulk", "Update or delete many companies", "Companies", 0),
		func(ctx context.Context, in *struct{ Body companyBulkBody }) (*struct{ Body bulkResult }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			b := in.Body
			empty := b.Patch != nil && len(b.Patch.AddTags) == 0 && len(b.Patch.RemoveTags) == 0 && len(b.Patch.Fields) == 0
			if err := bulkShape(len(b.IDs), b.Query != nil, b.Patch != nil, b.Delete, empty); err != nil {
				return nil, err
			}
			var out bulkResult
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var ids []uuid.UUID
				var err error
				if b.Query != nil {
					where, args, err := b.Query.where(ctx, tx, p)
					if err != nil {
						return err
					}
					ids, err = idsWhere(ctx, tx, "companies co", where, args)
					if err != nil {
						return err
					}
				} else if ids, err = workspaceIDs(ctx, tx, "companies", "Company", p.WorkspaceID, b.IDs); err != nil {
					return err
				}
				if b.Delete {
					for _, id := range ids {
						if err := deleteCompany(ctx, tx, p, id, map[string]any{"bulk": true}); err != nil {
							return err
						}
					}
					out.Deleted = len(ids)
					return nil
				}
				fields, err := newFieldsPatch(ctx, tx, p.WorkspaceID, "companies", domain.FieldEntityCompany, b.Patch.Fields)
				if err != nil {
					return err
				}
				for _, id := range ids {
					if err := applyLabels(ctx, tx, p, domain.CompanyLabels, id, nil, b.Patch.AddTags, b.Patch.RemoveTags); err != nil {
						return err
					}
					if err := fields.apply(ctx, tx, p.WorkspaceID, id); err != nil {
						return err
					}
					if err := bulkUpdated(ctx, tx, p, "companies", "company", id, func() (any, error) { return loadCompany(ctx, tx, p.WorkspaceID, id) }); err != nil {
						return err
					}
				}
				out.Updated = len(ids)
				return nil
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body bulkResult }{out}, nil
		})
}
