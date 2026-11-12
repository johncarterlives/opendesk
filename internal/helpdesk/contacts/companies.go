package contacts

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

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

// Company is the contract shape.
type Company struct {
	ID           uuid.UUID       `json:"id"`
	Name         string          `json:"name"`
	Domain       string          `json:"domain"`
	ExternalID   *string         `json:"external_id" doc:"Your product's own id for the account; the chat widget's identify links a signed-in user to the company with it"`
	AvatarURL    domain.Avatar   `json:"avatar_url" doc:"Logo"`
	AvatarSource *string         `json:"avatar_source" enum:"upload,domain"`
	Notes        string          `json:"notes"`
	Custom       map[string]any  `json:"custom"`
	Tags         []domain.TagRef `json:"tags"`
	Fields       map[string]any  `json:"fields"`
	ContactCount int             `json:"contact_count"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

var companySelect = `SELECT co.id, co.name, co.domain, co.external_id, co.avatar_url, co.avatar_source, co.notes, co.custom,
	(SELECT count(*) FROM contacts c WHERE c.workspace_id = co.workspace_id AND c.company_id = co.id), co.created_at, co.updated_at,
	co.fields, ` + domain.TagRefsSQL("company_tags", "lt.company_id = co.id") + `
FROM companies co`

func scanCompany(r pgx.Row) (Company, error) {
	var c Company
	var tags []byte
	err := r.Scan(&c.ID, &c.Name, &c.Domain, &c.ExternalID, &c.AvatarURL, &c.AvatarSource, &c.Notes, &c.Custom, &c.ContactCount, &c.CreatedAt, &c.UpdatedAt, &c.Fields, &tags)
	if c.Custom == nil {
		c.Custom = map[string]any{}
	}
	if c.Fields == nil {
		c.Fields = map[string]any{}
	}
	c.Tags = []domain.TagRef{}
	if err == nil {
		err = json.Unmarshal(tags, &c.Tags)
	}
	return c, err
}

func loadCompany(ctx context.Context, q db.Querier, wid, id uuid.UUID) (Company, error) {
	c, err := scanCompany(q.QueryRow(ctx, companySelect+` WHERE co.workspace_id = $1 AND co.id = $2`, wid, id))
	if db.IsNotFound(err) {
		return c, httpx.NotFound("Company")
	}
	return c, err
}

type companyWriteBody struct {
	Name       *string          `json:"name,omitempty" maxLength:"200"`
	Domain     *string          `json:"domain,omitempty" maxLength:"253"`
	ExternalID Nullable[string] `json:"external_id,omitempty" doc:"Your product's own id for the account, matched by the chat widget's identify; null clears it"`
	Notes      *string          `json:"notes,omitempty" maxLength:"10000"`
	Custom     map[string]any   `json:"custom,omitempty"`
	Tags       *[]string        `json:"tags,omitempty" maxItems:"50" doc:"Replaces the labels, by name"`
	AddTags    []string         `json:"add_tags,omitempty" maxItems:"50" doc:"Adds these labels, by name"`
	RemoveTags []string         `json:"remove_tags,omitempty" maxItems:"50" doc:"Removes these labels, by name"`
	Fields     map[string]any   `json:"fields,omitempty" doc:"Custom field values by key, merged; null clears a field"`
}

type companyRow struct {
	Name, Domain, Notes string
	ExternalID          *string
	Custom              map[string]any
	Fields              map[string]any
}

func (b *companyWriteBody) apply(row *companyRow) error {
	if b.Name != nil {
		s, err := cleanText("name", *b.Name, 200, false)
		if err != nil {
			return err
		}
		if strings.ContainsAny(s, "<>") {
			return httpx.Validation("name contains characters that are not allowed")
		}
		row.Name = strings.Join(strings.Fields(s), " ")
	}
	if row.Name == "" {
		return httpx.Validation("name is required")
	}
	if b.Domain != nil {
		s, err := cleanDomain(*b.Domain)
		if err != nil {
			return err
		}
		row.Domain = s
	}
	if b.ExternalID.Set {
		s := strings.TrimSpace(b.ExternalID.Value)
		if b.ExternalID.Null || s == "" {
			row.ExternalID = nil
		} else {
			s, err := cleanText("external_id", s, 200, false)
			if err != nil {
				return err
			}
			row.ExternalID = &s
		}
	}
	if b.Notes != nil {
		s, err := cleanText("notes", *b.Notes, 10000, true)
		if err != nil {
			return err
		}
		row.Notes = s
	}
	if b.Custom != nil {
		m, err := cleanCustom(b.Custom)
		if err != nil {
			return err
		}
		row.Custom = m
	}
	if row.Custom == nil {
		row.Custom = map[string]any{}
	}
	return nil
}

func companyUniqueErr(err error) error {
	if db.IsUniqueViolation(err, "companies_ws_domain_uq") {
		return httpx.Conflict("A company with this domain already exists.")
	}
	if db.IsUniqueViolation(err, "companies_ws_external_uq") {
		return httpx.Conflict("A company with this external_id already exists.")
	}
	return err
}

type companyOut struct{ Body Company }

// companySorts are the orders the Companies list can take, by their `sort` value; name, A to Z,
// is the default. The people count is the one companySelect reads.
var companySorts = func() map[string]listSort[Company] {
	name := nameSort("co.name", func(c Company) string { return c.Name })
	created := timeSort("co.created_at", func(c Company) time.Time { return c.CreatedAt })
	updated := timeSort("co.updated_at", func(c Company) time.Time { return c.UpdatedAt })
	people := countSort("(SELECT count(*) FROM contacts c WHERE c.workspace_id = co.workspace_id AND c.company_id = co.id)", func(c Company) int { return c.ContactCount })
	return map[string]listSort[Company]{"name": name, "-name": name, "created": created, "-created": created,
		"updated": updated, "-updated": updated, "contacts": people, "-contacts": people}
}()

// deleteCompany deletes a company of the caller's workspace, audits and announces it: the one
// way a company is deleted, alone or in bulk (meta is the audit entry's). Its people stay,
// without a company.
func deleteCompany(ctx context.Context, tx pgx.Tx, p *auth.Principal, id uuid.UUID, meta map[string]any) error {
	tag, err := tx.Exec(ctx, `DELETE FROM companies WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("Company")
	}
	if err := audit.Log(ctx, tx, p, p.WorkspaceID, "company.deleted", "company", &id, meta); err != nil {
		return err
	}
	_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "company.deleted", Data: map[string]any{"company_id": id}})
	return err
}

func registerCompanies(d *deps.Deps, api huma.API) {
	huma.Register(api, op("list-companies", http.MethodGet, "/v1/companies", "List companies", "Companies", 0),
		func(ctx context.Context, in *companyListIn) (*struct{ Body httpx.Page[Company] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if in.fieldsErr != nil {
				return nil, in.fieldsErr
			}
			where, args, err := companyFilter{Q: in.Q, Tag: in.Tag, Fields: in.fields}.where(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			pg, err := pageOf(companySorts, in.Sort, "name", "co.id", func(c Company) uuid.UUID { return c.ID }, in.Cursor, len(args)+1)
			if err != nil {
				return nil, err
			}
			args = append(args, pg.args...)
			args = append(args, in.Limit+1)
			rows, err := d.DB.Pool.Query(ctx, companySelect+where+pg.after+pg.orderBy()+" LIMIT $"+strconv.Itoa(len(args)), args...)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Company, error) { return scanCompany(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(list, in.Limit, pg.cursor)
			return &struct{ Body httpx.Page[Company] }{page}, nil
		})

	huma.Register(api, op("create-company", http.MethodPost, "/v1/companies", "Create a company", "Companies", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body companyWriteBody }) (*companyOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var row companyRow
			if err := in.Body.apply(&row); err != nil {
				return nil, err
			}
			var c Company
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := applyFields(ctx, tx, p.WorkspaceID, domain.FieldEntityCompany, &row.Fields, in.Body.Fields); err != nil {
					return err
				}
				id := ids.New()
				if _, err := tx.Exec(ctx, `INSERT INTO companies (id, workspace_id, name, domain, external_id, notes, custom, fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
					id, p.WorkspaceID, row.Name, row.Domain, row.ExternalID, row.Notes, row.Custom, row.Fields); err != nil {
					return companyUniqueErr(err)
				}
				if err := applyLabels(ctx, tx, p, domain.CompanyLabels, id, in.Body.Tags, in.Body.AddTags, in.Body.RemoveTags); err != nil {
					return err
				}
				var err error
				if c, err = loadCompany(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "company.created", Data: map[string]any{"company": c}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &companyOut{c}, nil
		})

	huma.Register(api, op("get-company", http.MethodGet, "/v1/companies/{id}", "Get a company", "Companies", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*companyOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Company")
			if err != nil {
				return nil, err
			}
			c, err := loadCompany(ctx, d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &companyOut{c}, nil
		})

	huma.Register(api, op("update-company", http.MethodPatch, "/v1/companies/{id}", "Update a company", "Companies", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body companyWriteBody
		}) (*companyOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Company")
			if err != nil {
				return nil, err
			}
			var c Company
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var row companyRow
				err := tx.QueryRow(ctx, `SELECT name, domain, external_id, notes, custom, fields FROM companies WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
					p.WorkspaceID, id).Scan(&row.Name, &row.Domain, &row.ExternalID, &row.Notes, &row.Custom, &row.Fields)
				oldDomain := row.Domain
				if db.IsNotFound(err) {
					return httpx.NotFound("Company")
				}
				if err != nil {
					return err
				}
				if err := in.Body.apply(&row); err != nil {
					return err
				}
				if err := applyFields(ctx, tx, p.WorkspaceID, domain.FieldEntityCompany, &row.Fields, in.Body.Fields); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE companies SET name = $3, domain = $4, external_id = $5, notes = $6, custom = $7, fields = $8, updated_at = now()
					WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, row.Name, row.Domain, row.ExternalID, row.Notes, row.Custom, row.Fields); err != nil {
					return companyUniqueErr(err)
				}
				if !strings.EqualFold(oldDomain, row.Domain) {
					// Look the logo up again for the new domain.
					if _, err := tx.Exec(ctx, `UPDATE companies SET avatar_retry_at = now(), avatar_failures = 0
						WHERE workspace_id = $1 AND id = $2 AND avatar_source IS DISTINCT FROM 'upload'`, p.WorkspaceID, id); err != nil {
						return err
					}
				}
				if err := applyLabels(ctx, tx, p, domain.CompanyLabels, id, in.Body.Tags, in.Body.AddTags, in.Body.RemoveTags); err != nil {
					return err
				}
				if c, err = loadCompany(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "company.updated", Data: map[string]any{"company": c}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &companyOut{c}, nil
		})

	huma.Register(api, op("delete-company", http.MethodDelete, "/v1/companies/{id}", "Delete a company", "Companies", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Company")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error { return deleteCompany(ctx, tx, p, id, nil) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}
