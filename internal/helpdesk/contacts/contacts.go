package contacts

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/images"
)

type contactWriteBody struct {
	Email      Nullable[string] `json:"email,omitempty" doc:"Email address; null clears it"`
	Name       *string          `json:"name,omitempty" maxLength:"200"`
	Phone      *string          `json:"phone,omitempty" maxLength:"50"`
	AvatarURL  *string          `json:"avatar_url,omitempty" maxLength:"2000" doc:"An https picture URL to copy (fetched and processed server-side, counts as an upload), or empty to remove the uploaded picture"`
	CompanyID  Nullable[string] `json:"company_id,omitempty" doc:"Company id; null clears it"`
	ExternalID Nullable[string] `json:"external_id,omitempty" doc:"Your system's id; null clears it"`
	Notes      *string          `json:"notes,omitempty" maxLength:"10000"`
	Custom     map[string]any   `json:"custom,omitempty"`
	Blocked    *bool            `json:"blocked,omitempty"`
	Tags       *[]string        `json:"tags,omitempty" maxItems:"50" doc:"Replaces the labels, by name"`
	AddTags    []string         `json:"add_tags,omitempty" maxItems:"50" doc:"Adds these labels, by name"`
	RemoveTags []string         `json:"remove_tags,omitempty" maxItems:"50" doc:"Removes these labels, by name"`
	Fields     map[string]any   `json:"fields,omitempty" doc:"Custom field values by key, merged; null clears a field"`
}

type contactOut struct{ Body domain.Contact }

type contactCursor struct {
	T  time.Time `json:"t"`
	ID uuid.UUID `json:"id"`
}

type ticketCursor struct {
	T  time.Time `json:"t"`
	ID uuid.UUID `json:"id"`
}

// contactRow is the editable state of a contact.
type contactRow struct {
	Email      *string
	Name       string
	Phone      string
	PictureURL *string // set: copy this picture ("" removes the manual one)
	CompanyID  *uuid.UUID
	ExternalID *string
	Notes      string
	Custom     map[string]any
	Blocked    bool
	Fields     map[string]any
}

// apply validates b and merges it into row.
func (b *contactWriteBody) apply(ctx context.Context, q db.Querier, wid uuid.UUID, row *contactRow) error {
	if b.Email.Set {
		if b.Email.Null {
			row.Email = nil
		} else {
			e, err := cleanEmail(b.Email.Value)
			if err != nil {
				return err
			}
			if e == "" {
				row.Email = nil
			} else {
				row.Email = &e
			}
		}
	}
	if b.Name != nil {
		n, err := displayname.Validate("Name", *b.Name, displayname.Person, true)
		if err != nil {
			return err
		}
		row.Name = n
	}
	if row.Name == "" && row.Email != nil {
		row.Name = displayname.FromEmail(*row.Email)
	}
	if b.Phone != nil {
		s, err := cleanText("phone", *b.Phone, 50, false)
		if err != nil {
			return err
		}
		row.Phone = s
	}
	if b.AvatarURL != nil {
		s, err := cleanAvatar(*b.AvatarURL)
		if err != nil {
			return err
		}
		row.PictureURL = &s
	}
	if b.CompanyID.Set {
		if b.CompanyID.Null || strings.TrimSpace(b.CompanyID.Value) == "" {
			row.CompanyID = nil
		} else {
			id, err := hd.ParseRef(b.CompanyID.Value, "company_id")
			if err != nil {
				return err
			}
			if err := hd.CheckRef(ctx, q, wid, "company", id); err != nil {
				return err
			}
			row.CompanyID = &id
		}
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
	if b.Blocked != nil {
		row.Blocked = *b.Blocked
	}
	if row.Custom == nil {
		row.Custom = map[string]any{}
	}
	return nil
}

func uniqueErr(err error) error {
	switch {
	case db.IsUniqueViolation(err, "contacts_ws_email_uq"):
		return httpx.Conflict("A contact with this email already exists.")
	case db.IsUniqueViolation(err, "contacts_ws_external_uq"):
		return httpx.Conflict("A contact with this external_id already exists.")
	}
	return err
}

func registerContacts(d *deps.Deps, api huma.API) {
	huma.Register(api, op("list-contacts", http.MethodGet, "/v1/contacts", "List contacts", "Contacts", 0),
		func(ctx context.Context, in *contactListIn) (*struct{ Body httpx.Page[domain.Contact] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			extra, args, err := recordFilters(ctx, d.DB.Pool, p, domain.ContactLabels, domain.FieldEntityContact, "ct", in.Tag, in.fields, in.fieldsErr, 7)
			if err != nil {
				return nil, err
			}
			var cur contactCursor
			if err := httpx.DecodeCursor(in.Cursor, &cur); err != nil {
				return nil, err
			}
			var companyID *uuid.UUID
			if in.CompanyID != "" {
				id, err := hd.ParseRef(in.CompanyID, "company_id")
				if err != nil {
					return nil, err
				}
				companyID = &id
			}
			var curT *time.Time
			if in.Cursor != "" {
				curT = &cur.T
			}
			q := strings.TrimSpace(in.Q)
			rows, err := d.DB.Pool.Query(ctx, domain.ContactSelect+` WHERE ct.workspace_id = $1
				AND ($2 = '' OR ct.search @@ websearch_to_tsquery('simple', $2) OR ct.fields_search @@ websearch_to_tsquery('simple', $2)
					OR ct.email::text ILIKE $3 OR ct.name ILIKE $3)
				AND ($4::uuid IS NULL OR ct.company_id = $4)
				AND ($5::timestamptz IS NULL OR (ct.created_at, ct.id) < ($5, $6))`+extra+`
				ORDER BY ct.created_at DESC, ct.id DESC LIMIT $7`,
				append([]any{p.WorkspaceID, q, likePrefix(q), companyID, curT, cur.ID, in.Limit + 1}, args...)...)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Contact, error) { return domain.ScanContact(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(list, in.Limit, func(c domain.Contact) any { return contactCursor{T: c.CreatedAt, ID: c.ID} })
			return &struct{ Body httpx.Page[domain.Contact] }{page}, nil
		})

	huma.Register(api, op("create-contact", http.MethodPost, "/v1/contacts", "Create a contact", "Contacts", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body contactWriteBody }) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var c domain.Contact
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				row := contactRow{}
				if err := in.Body.apply(ctx, tx, p.WorkspaceID, &row); err != nil {
					return err
				}
				if row.Email == nil && row.Name == "" {
					return httpx.Validation("a contact needs an email or a name")
				}
				if err := applyFields(ctx, tx, p.WorkspaceID, domain.FieldEntityContact, &row.Fields, in.Body.Fields); err != nil {
					return err
				}
				id := ids.New()
				if _, err := tx.Exec(ctx, `INSERT INTO contacts (id, workspace_id, email, name, phone, company_id,
					external_id, notes, custom, blocked, fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
					id, p.WorkspaceID, row.Email, row.Name, row.Phone, row.CompanyID, row.ExternalID,
					row.Notes, row.Custom, row.Blocked, row.Fields); err != nil {
					return uniqueErr(err)
				}
				if _, err := pictureFromURL(ctx, d, tx, p.WorkspaceID, id, row.PictureURL); err != nil {
					return err
				}
				if err := applyLabels(ctx, tx, p, domain.ContactLabels, id, in.Body.Tags, in.Body.AddTags, in.Body.RemoveTags); err != nil {
					return err
				}
				if c, err = domain.LoadContact(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.created", Data: map[string]any{"contact": c}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})

	huma.Register(api, op("get-contact", http.MethodGet, "/v1/contacts/{id}", "Get a contact", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			c, err := domain.LoadContact(ctx, d.DB.Pool, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Contact")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})

	huma.Register(api, op("update-contact", http.MethodPatch, "/v1/contacts/{id}", "Update a contact", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body contactWriteBody
		}) (*contactOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			var c domain.Contact
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var row contactRow
				var oldEmail *string
				err := tx.QueryRow(ctx, `SELECT email, name, phone, company_id, external_id, notes, custom, blocked, fields
					FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, p.WorkspaceID, id).
					Scan(&row.Email, &row.Name, &row.Phone, &row.CompanyID, &row.ExternalID, &row.Notes, &row.Custom, &row.Blocked, &row.Fields)
				oldEmail = row.Email
				if db.IsNotFound(err) {
					return httpx.NotFound("Contact")
				}
				if err != nil {
					return err
				}
				if err := in.Body.apply(ctx, tx, p.WorkspaceID, &row); err != nil {
					return err
				}
				if row.Email == nil && row.Name == "" {
					return httpx.Validation("a contact needs an email or a name")
				}
				if err := applyFields(ctx, tx, p.WorkspaceID, domain.FieldEntityContact, &row.Fields, in.Body.Fields); err != nil {
					return err
				}
				// The contacts_customer_identity trigger ends customer credentials, sessions
				// and reset links when the email changes or the contact is blocked.
				if _, err := tx.Exec(ctx, `UPDATE contacts SET email = $3, name = $4, phone = $5, company_id = $6,
					external_id = $7, notes = $8, custom = $9, blocked = $10, fields = $11, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
					p.WorkspaceID, id, row.Email, row.Name, row.Phone, row.CompanyID, row.ExternalID,
					row.Notes, row.Custom, row.Blocked, row.Fields); err != nil {
					return uniqueErr(err)
				}
				if prefix, err := pictureFromURL(ctx, d, tx, p.WorkspaceID, id, row.PictureURL); err != nil {
					return err
				} else if prefix != "" {
					defer images.Discard(d.Storage, prefix)
				}
				if !sameEmail(oldEmail, row.Email) {
					// A new address may have a different Gravatar picture.
					if _, err := tx.Exec(ctx, `UPDATE contacts SET avatar_retry_at = now(), avatar_failures = 0
						WHERE workspace_id = $1 AND id = $2 AND avatar_source IS DISTINCT FROM 'upload'`, p.WorkspaceID, id); err != nil {
						return err
					}
				}
				if err := applyLabels(ctx, tx, p, domain.ContactLabels, id, in.Body.Tags, in.Body.AddTags, in.Body.RemoveTags); err != nil {
					return err
				}
				if c, err = domain.LoadContact(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.updated", Data: map[string]any{"contact": c}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &contactOut{c}, nil
		})

	huma.Register(api, op("delete-contact", http.MethodDelete, "/v1/contacts/{id}", "Delete a contact", "Contacts", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				tag, err := tx.Exec(ctx, `DELETE FROM contacts WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if tag.RowsAffected() == 0 {
					return httpx.NotFound("Contact")
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "contact.deleted", Data: map[string]any{"contact_id": id}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})

	huma.Register(api, op("list-contact-tickets", http.MethodGet, "/v1/contacts/{id}/tickets", "List a contact's tickets", "Contacts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
			httpx.ListParams
		}) (*struct{ Body httpx.Page[domain.Ticket] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if p.Kind == auth.KindAPIKey && !p.HasScope(auth.ScopeTicketsRead) {
				return nil, httpx.Forbidden()
			}
			id, err := hd.ParseID(in.ID, "Contact")
			if err != nil {
				return nil, err
			}
			if err := hd.CheckRef(ctx, d.DB.Pool, p.WorkspaceID, "contact", id); err != nil {
				return nil, httpx.NotFound("Contact")
			}
			var cur ticketCursor
			if err := httpx.DecodeCursor(in.Cursor, &cur); err != nil {
				return nil, err
			}
			var curT *time.Time
			if in.Cursor != "" {
				curT = &cur.T
			}
			hidden, err := domain.HiddenTeams(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := d.DB.Pool.Query(ctx, domain.TicketSelect+` WHERE t.workspace_id = $1 AND t.contact_id = $2 AND t.deleted_at IS NULL
				AND ($3::timestamptz IS NULL OR (t.last_message_at, t.id) < ($3, $4))
				AND `+domain.VisibleSQLUser("t", 6, 7)+`
				ORDER BY t.last_message_at DESC, t.id DESC LIMIT $5`, p.WorkspaceID, id, curT, cur.ID, in.Limit+1, hidden, p.ActorUserID())
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Ticket, error) { return domain.ScanTicket(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(list, in.Limit, func(t domain.Ticket) any { return ticketCursor{T: t.LastMessageAt, ID: t.ID} })
			return &struct{ Body httpx.Page[domain.Ticket] }{page}, nil
		})
}
