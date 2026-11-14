package tickets

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// A member's own reply draft (contracts/api.md "Reply drafts"): the reply they are writing on
// a ticket, saved as they type so it follows them to another device and survives a refresh.
// It is the member's alone, never shown to a teammate, and goes when their reply to the
// ticket is sent (domain.AddMessage) or they discard it. Not the ticket's shared draft
// (drafts.go), which a teammate or an AI agent stages for whoever opens the ticket next.

// ReplyDraft is a member's unsent reply on a ticket.
type ReplyDraft struct {
	TicketID    uuid.UUID           `json:"ticket_id"`
	BodyHTML    string              `json:"body_html"`
	Attachments []domain.Attachment `json:"attachments"`
	UpdatedAt   time.Time           `json:"updated_at"`
	// Schedule is when and how it goes out, if it is scheduled (scheduled_replies.go).
	Schedule *ScheduledSend `json:"schedule" doc:"When and how the reply goes out, if you scheduled it; null otherwise"`
	// SendError is why a scheduled send did not go out; the draft stayed.
	SendError string `json:"send_error" doc:"Why the reply did not go out at its scheduled time, or empty"`
}

// ReplyDraftInput is PUT /v1/tickets/{id}/reply-draft. Without text, an image or a file it
// discards the draft.
type ReplyDraftInput struct {
	BodyHTML      string   `json:"body_html" maxLength:"500000"`
	AttachmentIDs []string `json:"attachment_ids,omitempty" maxItems:"20" doc:"Your uploads that are not on a message yet"`
}

// ReplyDraftRetention is how long an untouched reply draft is kept.
const ReplyDraftRetention = 30 * 24 * time.Hour

func loadReplyDraft(ctx context.Context, q db.Querier, wid, tid, uid uuid.UUID) (*ReplyDraft, error) {
	d := ReplyDraft{TicketID: tid, Attachments: []domain.Attachment{}}
	var ids []uuid.UUID
	var sendAt *time.Time
	var request []byte
	err := q.QueryRow(ctx, `SELECT body_html, attachment_ids, updated_at, send_at, send_request, send_error FROM ticket_reply_drafts
		WHERE workspace_id = $1 AND ticket_id = $2 AND user_id = $3`, wid, tid, uid).Scan(&d.BodyHTML, &ids, &d.UpdatedAt, &sendAt, &request, &d.SendError)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if sendAt != nil && request != nil {
		var in MessageInput
		if err := json.Unmarshal(request, &in); err != nil {
			return nil, err
		}
		s := ScheduledSend{SendAt: *sendAt}.from(in)
		d.Schedule = &s
	}
	if len(ids) > 0 {
		// Only files still there: a purged upload is dropped from the draft.
		rows, err := q.Query(ctx, `SELECT id, filename, content_type, size_bytes, inline FROM attachments
			WHERE workspace_id = $1 AND id = ANY($2) AND message_id IS NULL ORDER BY created_at`, wid, ids)
		if err != nil {
			return nil, err
		}
		d.Attachments, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Attachment, error) {
			var a domain.Attachment
			err := r.Scan(&a.ID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.Inline)
			a.URL = domain.AttachmentURL(a.ID)
			return a, err
		})
		if err != nil {
			return nil, err
		}
	}
	return &d, nil
}

func registerReplyDrafts(d *deps.Deps, api huma.API) {
	tags := []string{"Tickets"}
	type draftOut struct {
		Body struct {
			Draft *ReplyDraft `json:"draft"`
		}
	}
	member := func(ctx context.Context, scope string, role auth.Role) (*auth.Principal, error) {
		p, err := auth.RequireWorkspace(ctx, role, scope)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		if p.ActorUserID() == nil {
			return nil, httpx.E(http.StatusForbidden, "forbidden", "A reply draft belongs to a signed-in member.")
		}
		return p, nil
	}

	huma.Register(api, huma.Operation{OperationID: "get-reply-draft", Method: http.MethodGet, Path: "/v1/tickets/{id}/reply-draft",
		Summary: "Get your reply draft", Description: "The reply you started on this ticket and have not sent, or null. Yours alone.", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*draftOut, error) {
			p, err := member(ctx, auth.ScopeTicketsRead, auth.RoleAgent)
			if err != nil {
				return nil, err
			}
			tid, err := domain.ResolveVisibleTicket(ctx, d.DB.Pool, p, in.ID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &draftOut{}
			if out.Body.Draft, err = loadReplyDraft(ctx, d.DB.Pool, p.WorkspaceID, tid, p.UserID); err != nil {
				return nil, httpx.Wrap(err)
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "put-reply-draft", Method: http.MethodPut, Path: "/v1/tickets/{id}/reply-draft",
		Summary: "Save your reply draft", Description: "Saves the reply you are writing, replacing the one before. An empty body without files discards it.", Tags: tags},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body ReplyDraftInput
		}) (*draftOut, error) {
			p, err := member(ctx, auth.ScopeTicketsWrite, auth.RoleAgent)
			if err != nil {
				return nil, err
			}
			html := hd.SanitizeRich(in.Body.BodyHTML)
			text := hd.HTMLToText(html)
			attIDs, err := hd.ParseAttachmentIDs(in.Body.AttachmentIDs)
			if err != nil {
				return nil, err
			}
			empty := text == "" && !strings.Contains(html, "<img") && len(attIDs) == 0
			out := &draftOut{}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				tid, err := domain.ResolveVisibleTicket(ctx, tx, p, in.ID)
				if err != nil {
					return err
				}
				// A scheduled reply goes out as it was scheduled: cancel it to change it.
				var scheduled bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ticket_reply_drafts WHERE workspace_id = $1 AND ticket_id = $2
					AND user_id = $3 AND send_at IS NOT NULL)`, p.WorkspaceID, tid, p.UserID).Scan(&scheduled); err != nil {
					return err
				}
				if scheduled {
					return httpx.E(http.StatusConflict, "reply_scheduled", "This reply is scheduled. Cancel the schedule to change it.")
				}
				if empty {
					_, err := tx.Exec(ctx, `DELETE FROM ticket_reply_drafts WHERE workspace_id = $1 AND ticket_id = $2 AND user_id = $3 AND send_at IS NULL`,
						p.WorkspaceID, tid, p.UserID)
					return err
				}
				if err := hd.CheckAttachments(ctx, tx, p.WorkspaceID, attIDs, hd.Uploader{User: &p.UserID}); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO ticket_reply_drafts (ticket_id, user_id, workspace_id, body_html, body_text, attachment_ids)
					VALUES ($1, $2, $3, $4, $5, $6)
					ON CONFLICT (ticket_id, user_id) DO UPDATE SET body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text,
						attachment_ids = EXCLUDED.attachment_ids, updated_at = now() WHERE ticket_reply_drafts.send_at IS NULL`,
					tid, p.UserID, p.WorkspaceID, html, text, attIDs); err != nil {
					return err
				}
				out.Body.Draft, err = loadReplyDraft(ctx, tx, p.WorkspaceID, tid, p.UserID)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-reply-draft", Method: http.MethodDelete, Path: "/v1/tickets/{id}/reply-draft",
		Summary: "Discard your reply draft", Description: "Nothing is sent. Idempotent.", Tags: tags, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := member(ctx, auth.ScopeTicketsWrite, auth.RoleAgent)
			if err != nil {
				return nil, err
			}
			tid, err := domain.ResolveVisibleTicket(ctx, d.DB.Pool, p, in.ID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if _, err := d.DB.Pool.Exec(ctx, `DELETE FROM ticket_reply_drafts WHERE workspace_id = $1 AND ticket_id = $2 AND user_id = $3 AND send_at IS NULL`,
				p.WorkspaceID, tid, p.UserID); err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}
