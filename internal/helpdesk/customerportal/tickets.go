package customerportal

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
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/helpdesk/routing"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// newRequestsPerHour bounds the requests one signed-in customer can start, counted for the
// whole instance: a session otherwise opens tickets without limit.
const newRequestsPerHour = 10

// workspaceRequestsPerHour bounds the requests all of a workspace's customers start together,
// counted for the whole instance, so many accounts cannot flood one inbox through the portal.
// A variable so a test can reach it.
var workspaceRequestsPerHour = 500

// These projections contain only the customer's request and public conversation.
// Agent-only ticket and message fields never enter a portal response.
type customerTicket struct {
	ID        uuid.UUID `json:"id"`
	Number    int64     `json:"number"`
	Subject   string    `json:"subject"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
type customerMessage struct {
	ID          uuid.UUID            `json:"id"`
	Direction   string               `json:"direction"`
	BodyText    string               `json:"body_text"`
	CreatedAt   time.Time            `json:"created_at"`
	Attachments []customerAttachment `json:"attachments"`
}
type portalCursor struct {
	At time.Time `json:"at"`
	ID uuid.UUID `json:"id"`
}

func decodePortalCursor(value string) (portalCursor, error) {
	var c portalCursor
	if len(value) > 512 {
		return c, httpx.BadRequest("invalid cursor")
	}
	if err := httpx.DecodeCursor(value, &c); err != nil {
		return c, err
	}
	if value != "" && (c.At.IsZero() || c.ID == uuid.Nil) {
		return c, httpx.BadRequest("invalid cursor")
	}
	return c, nil
}

func (s *service) registerTickets(api huma.API) {
	const prefix = "/v1/customer/portal/tickets"
	huma.Register(api, s.operation("customer-portal-list-tickets", http.MethodGet, prefix, "List your support requests", false),
		func(ctx context.Context, in *struct{ httpx.ListParams }) (*struct{ Body httpx.Page[customerTicket] }, error) {
			p, err := auth.RequireCustomer(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			c, err := decodePortalCursor(in.Cursor)
			if err != nil {
				return nil, err
			}
			rows, err := s.d.DB.Pool.Query(ctx, `SELECT id,number,subject,status,created_at,updated_at FROM tickets
    WHERE workspace_id=$1 AND contact_id=$2 AND deleted_at IS NULL AND NOT spam
    AND ($3 OR (updated_at,id)<($4,$5)) ORDER BY updated_at DESC,id DESC LIMIT $6`,
				p.WorkspaceID, p.ContactID, in.Cursor == "", c.At, c.ID, in.Limit+1)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			tickets, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (customerTicket, error) { return scanCustomerTicket(r) })
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			page := httpx.NewPage(tickets, in.Limit, func(t customerTicket) any { return portalCursor{t.UpdatedAt, t.ID} })
			return &struct{ Body httpx.Page[customerTicket] }{page}, nil
		})
	huma.Register(api, s.operation("customer-portal-get-ticket", http.MethodGet, prefix+"/{id}", "Read your support request", false),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body customerTicket }, error) {
			p, err := auth.RequireCustomer(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			t, err := loadCustomerTicket(ctx, s.d.DB.Pool, p, in.ID, false)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body customerTicket }{t}, nil
		})
	huma.Register(api, s.operation("customer-portal-list-messages", http.MethodGet, prefix+"/{id}/messages", "Read your public conversation", false),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
			httpx.ListParams
		}) (*struct{ Body httpx.Page[customerMessage] }, error) {
			p, err := auth.RequireCustomer(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			t, err := loadCustomerTicket(ctx, s.d.DB.Pool, p, in.ID, false)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			c, err := decodePortalCursor(in.Cursor)
			if err != nil {
				return nil, err
			}
			rows, err := s.d.DB.Pool.Query(ctx, `SELECT m.id,m.direction,m.body_text,m.created_at FROM messages m
    JOIN tickets t ON t.workspace_id=m.workspace_id AND t.id=m.ticket_id
    WHERE t.workspace_id=$1 AND t.contact_id=$2 AND t.id=$3 AND t.deleted_at IS NULL AND NOT t.spam
    AND m.kind='reply' AND m.thread_id IS NULL AND NOT m.auth_failed
    AND m.deleted_at IS NULL AND m.purged_at IS NULL AND m.sent_as_reply_id IS NULL
    AND ($4 OR (m.created_at,m.id)>($5,$6)) ORDER BY m.created_at,m.id LIMIT $7`,
				p.WorkspaceID, p.ContactID, t.ID, in.Cursor == "", c.At, c.ID, in.Limit+1)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			messages, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (customerMessage, error) {
				var m customerMessage
				err := r.Scan(&m.ID, &m.Direction, &m.BodyText, &m.CreatedAt)
				return m, err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			ids := make([]uuid.UUID, len(messages))
			for i, m := range messages {
				ids[i] = m.ID
			}
			files, err := attachmentsOf(ctx, s.d.DB.Pool, p.WorkspaceID, ids)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			for i := range messages {
				messages[i].Attachments = files[messages[i].ID]
				if messages[i].Attachments == nil {
					messages[i].Attachments = []customerAttachment{}
				}
			}
			page := httpx.NewPage(messages, in.Limit, func(m customerMessage) any { return portalCursor{m.CreatedAt, m.ID} })
			return &struct{ Body httpx.Page[customerMessage] }{page}, nil
		})
	create := s.operation("customer-portal-create-ticket", http.MethodPost, prefix, "Start a support request", false)
	create.DefaultStatus = http.StatusCreated
	huma.Register(api, create, func(ctx context.Context, in *struct {
		Body struct {
			Slug    string `json:"workspace_slug" minLength:"1" maxLength:"40" doc:"The portal's brand; never selects the workspace, which is the customer's own"`
			Subject string `json:"subject" minLength:"1" maxLength:"200"`
			Body    string `json:"body" minLength:"1" maxLength:"10000"`
			// AttachmentIDs are this customer's own uploads (POST /v1/customer/portal/attachments).
			AttachmentIDs []string `json:"attachment_ids,omitempty" maxItems:"20" doc:"Files from POST /v1/customer/portal/attachments, at most 5"`
		}
	}) (*struct{ Body customerTicket }, error) {
		p, err := auth.RequireCustomer(ctx)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		subject, text := strings.Join(strings.Fields(in.Body.Subject), " "), strings.TrimSpace(in.Body.Body)
		if subject == "" || text == "" {
			return nil, httpx.E(http.StatusUnprocessableEntity, "validation_failed", "Add a subject and describe your request.")
		}
		hc, err := helpCenter(ctx, s.d, in.Body.Slug)
		if err != nil {
			return nil, err
		}
		// The brand is the portal being used; the workspace and the customer are the session's own.
		if hc.WorkspaceID != p.WorkspaceID {
			return nil, httpx.NotFound("Help center")
		}
		if err := s.limit(ctx, "new-ticket:"+p.WorkspaceID.String()+":"+p.ContactID.String(), newRequestsPerHour, time.Hour); err != nil {
			return nil, err
		}
		// Counted after the customer's own limit, so one customer cannot use up the workspace's.
		if !s.d.Limiter.Shared(ctx, "customer-portal:new-ticket-workspace:"+p.WorkspaceID.String(), workspaceRequestsPerHour, time.Hour) {
			return nil, httpx.E(http.StatusTooManyRequests, "portal_busy", "This help center is receiving many requests. Wait a while and try again.")
		}
		var out customerTicket
		err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
			// Hold the contact stable until the ticket and its message commit, so a block or an
			// address change cannot slip between the session check and the write.
			var blocked bool
			if err := tx.QueryRow(ctx, `SELECT blocked FROM contacts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, p.WorkspaceID, p.ContactID).Scan(&blocked); err != nil {
				return err
			}
			if blocked {
				return auth.ErrUnauthenticated
			}
			files, err := s.requestFiles(ctx, tx, p, in.Body.AttachmentIDs)
			if err != nil {
				return err
			}
			var email *string
			if err := tx.QueryRow(ctx, `SELECT email FROM contacts WHERE workspace_id=$1 AND id=$2`, p.WorkspaceID, p.ContactID).Scan(&email); err != nil {
				return err
			}
			fromEmail := ""
			if email != nil {
				fromEmail = *email
			}
			brandID := hc.BrandID
			res, err := routing.Resolve(ctx, tx, routing.Input{WorkspaceID: p.WorkspaceID, Channel: domain.ChannelPortal, BrandID: brandID,
				FromEmail: fromEmail, Subject: subject, Body: text, ContactID: &p.ContactID})
			if err != nil {
				return err
			}
			t, err := domain.CreateTicket(ctx, tx, domain.NewTicket{WorkspaceID: p.WorkspaceID, Subject: subject, Channel: domain.ChannelPortal,
				ContactID: &p.ContactID, TeamID: res.TeamID, Routed: res.Routed, BrandID: &brandID, RequiredSkillIDs: res.RequiredSkillIDs})
			if err != nil {
				return err
			}
			if rule := res.RuleID(); rule != nil {
				if err := routing.Count(ctx, tx, *rule); err != nil {
					return err
				}
			}
			if _, err := domain.AddMessage(ctx, tx, s.d.Jobs, domain.NewMessage{
				WorkspaceID: p.WorkspaceID, TicketID: t.ID, Kind: "reply", Direction: "inbound",
				AuthorType: "contact", AuthorContactID: &p.ContactID, BodyHTML: hd.TextToHTML(text), BodyText: text,
				Trigger: jobs.TriggerTicketCreated, AttachmentIDs: files,
			}); err != nil {
				return err
			}
			out = customerTicket{ID: t.ID, Number: t.Number, Subject: t.Subject, Status: t.Status, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt}
			return nil
		})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct{ Body customerTicket }{out}, nil
	})
	op := s.operation("customer-portal-post-message", http.MethodPost, prefix+"/{id}/messages", "Reply to your support request", false)
	op.DefaultStatus = http.StatusCreated
	huma.Register(api, op, func(ctx context.Context, in *struct {
		ID   string `path:"id"`
		Body struct {
			Body string `json:"body" minLength:"1" maxLength:"10000"`
		}
	}) (*struct{ Body customerMessage }, error) {
		p, err := auth.RequireCustomer(ctx)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		text := strings.TrimSpace(in.Body.Body)
		if text == "" {
			return nil, httpx.E(http.StatusUnprocessableEntity, "validation_failed", "Write a reply first.")
		}
		var message customerMessage
		err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
			// Hold ownership stable until AddMessage and its events/jobs commit.
			t, err := loadCustomerTicket(ctx, tx, p, in.ID, true)
			if err != nil {
				return err
			}
			m, err := domain.AddMessage(ctx, tx, s.d.Jobs, domain.NewMessage{
				WorkspaceID: p.WorkspaceID, TicketID: t.ID, Kind: "reply", Direction: "inbound",
				AuthorType: "contact", AuthorContactID: &p.ContactID, BodyHTML: hd.TextToHTML(text), BodyText: text,
			})
			if err != nil {
				return err
			}
			message = customerMessage{m.ID, m.Direction, m.BodyText, m.CreatedAt, []customerAttachment{}}
			return nil
		})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct{ Body customerMessage }{message}, nil
	})
}

func scanCustomerTicket(row pgx.Row) (customerTicket, error) {
	var t customerTicket
	err := row.Scan(&t.ID, &t.Number, &t.Subject, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}
func loadCustomerTicket(ctx context.Context, q db.Querier, p *auth.Principal, value string, lock bool) (customerTicket, error) {
	id, ok := ids.Parse(value)
	if !ok {
		return customerTicket{}, httpx.NotFound("Ticket")
	}
	query := `SELECT id,number,subject,status,created_at,updated_at FROM tickets
  WHERE workspace_id=$1 AND contact_id=$2 AND id=$3 AND deleted_at IS NULL AND NOT spam`
	if lock {
		query += " FOR UPDATE"
	}
	t, err := scanCustomerTicket(q.QueryRow(ctx, query, p.WorkspaceID, p.ContactID, id))
	if db.IsNotFound(err) {
		return t, httpx.NotFound("Ticket")
	}
	return t, err
}
