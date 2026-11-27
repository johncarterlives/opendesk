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
	"github.com/useopendesk/opendesk/internal/collab"
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
	// The rest of the reply as it was being written: who it goes to and the address it goes from.
	To          []string          `json:"to" doc:"Who the reply goes to; null: the customer's reply address"`
	Cc          []string          `json:"cc"`
	Bcc         []string          `json:"bcc"`
	MailboxID   *uuid.UUID        `json:"mailbox_id" doc:"The address it goes from, when another than the ticket's was picked and it is still there; null otherwise"`
	FromAccount *DraftFromAccount `json:"from_account" doc:"One of your own Collab addresses it goes from, while you still see its account; null otherwise"`
	// Schedule is when and how it goes out, if it is scheduled (scheduled_replies.go).
	Schedule *ScheduledSend `json:"schedule" doc:"When and how the reply goes out, if you scheduled it; null otherwise"`
	// SendError is why a scheduled send did not go out; the draft stayed.
	SendError string `json:"send_error" doc:"Why the reply did not go out at its scheduled time, or empty"`
}

// ReplyDraftInput is PUT /v1/tickets/{id}/reply-draft. Without text, an image or a file it
// discards the draft.
type ReplyDraftInput struct {
	BodyHTML      string            `json:"body_html" maxLength:"500000"`
	AttachmentIDs []string          `json:"attachment_ids,omitempty" maxItems:"20" doc:"Your uploads that are not on a message yet"`
	To            []string          `json:"to,omitempty" maxItems:"20" doc:"Who the reply goes to; left out or empty: the customer's reply address"`
	Cc            []string          `json:"cc,omitempty" maxItems:"20"`
	Bcc           []string          `json:"bcc,omitempty" maxItems:"20"`
	MailboxID     string            `json:"mailbox_id,omitempty" doc:"The address it goes from, an address of this workspace"`
	FromAccount   *FromAccountInput `json:"from_account,omitempty" doc:"One of your own Collab addresses it goes from, an account you see; not with mailbox_id"`
}

// DraftFromAccount is the Collab address a reply draft goes from, as from_account of a send.
type DraftFromAccount struct {
	AccountID uuid.UUID `json:"account_id"`
	Email     string    `json:"email"`
	ReplyTo   string    `json:"reply_to"`
}

// draftRecipients is who a reply draft goes to and from, checked and ready to store.
type draftRecipients struct {
	to, cc, bcc []string
	mailboxID   *uuid.UUID
	fromAccount []byte
}

// parseDraftRecipients checks what a draft or a scheduled reply names: valid addresses, at most
// 20 of each (the body's limits), an address of the workspace and a Collab account the member sees.
// What can be sent from is checked when it is sent.
func parseDraftRecipients(ctx context.Context, q db.Querier, p *auth.Principal, to, cc, bcc []string, mailbox string, from *FromAccountInput) (draftRecipients, error) {
	var r draftRecipients
	var err error
	if r.to, err = cleanEmails(to); err != nil {
		return r, err
	}
	if len(r.to) == 0 {
		r.to = nil
	}
	if r.cc, err = cleanEmails(cc); err != nil {
		return r, err
	}
	if r.bcc, err = cleanEmails(bcc); err != nil {
		return r, err
	}
	if strings.TrimSpace(mailbox) != "" {
		if from != nil {
			return r, httpx.Validation("send from mailbox_id or from_account, not both")
		}
		id, err := hd.ParseRef(mailbox, "mailbox_id")
		if err != nil {
			return r, err
		}
		if err := hd.CheckRef(ctx, q, p.WorkspaceID, "mailbox", id); err != nil {
			return r, err
		}
		r.mailboxID = &id
	}
	if from != nil {
		id, err := hd.ParseRef(from.AccountID, "from_account.account_id")
		if err != nil {
			return r, err
		}
		var seen bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM collab_accounts a WHERE a.workspace_id = $1 AND a.id = $2 AND `+
			collab.AccountVisibleSQL("a", "$3")+`)`, p.WorkspaceID, id, p.UserID).Scan(&seen); err != nil {
			return r, err
		}
		if !seen {
			return r, httpx.Validation("from_account: account not found")
		}
		f := DraftFromAccount{AccountID: id, ReplyTo: strings.TrimSpace(from.ReplyTo)}
		if strings.TrimSpace(from.Email) != "" {
			if f.Email, err = cleanEmail(from.Email); err != nil {
				return r, err
			}
		}
		if f.ReplyTo != "" && f.ReplyTo != "address" && f.ReplyTo != "mailbox" {
			if f.ReplyTo, err = cleanEmail(f.ReplyTo); err != nil {
				return r, err
			}
		}
		if r.fromAccount, err = json.Marshal(f); err != nil {
			return r, err
		}
	}
	return r, nil
}

// ReplyDraftRetention is how long an untouched reply draft is kept.
const ReplyDraftRetention = 30 * 24 * time.Hour

func loadReplyDraft(ctx context.Context, q db.Querier, wid, tid, uid uuid.UUID) (*ReplyDraft, error) {
	d := ReplyDraft{TicketID: tid, Attachments: []domain.Attachment{}}
	var ids []uuid.UUID
	var sendAt *time.Time
	var request, from []byte
	// The address and the account come back only while they are there to send from.
	err := q.QueryRow(ctx, `SELECT rd.body_html, rd.attachment_ids, rd.updated_at, rd.send_at, rd.send_request, rd.send_error,
			rd.to_addresses, rd.cc, rd.bcc, mb.id, CASE WHEN ca.id IS NOT NULL THEN rd.from_account END
		FROM ticket_reply_drafts rd
		LEFT JOIN mailboxes mb ON mb.workspace_id = rd.workspace_id AND mb.id = rd.mailbox_id AND mb.status <> 'disabled'
		LEFT JOIN collab_accounts ca ON ca.workspace_id = rd.workspace_id AND ca.id = (rd.from_account->>'account_id')::uuid
			AND `+collab.AccountVisibleSQL("ca", "rd.user_id")+`
		WHERE rd.workspace_id = $1 AND rd.ticket_id = $2 AND rd.user_id = $3`, wid, tid, uid).
		Scan(&d.BodyHTML, &ids, &d.UpdatedAt, &sendAt, &request, &d.SendError, &d.To, &d.Cc, &d.Bcc, &d.MailboxID, &from)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(d.To) == 0 {
		d.To = nil
	}
	if from != nil {
		d.FromAccount = &DraftFromAccount{}
		if err := json.Unmarshal(from, d.FromAccount); err != nil {
			return nil, err
		}
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
				r, err := parseDraftRecipients(ctx, tx, p, in.Body.To, in.Body.Cc, in.Body.Bcc, in.Body.MailboxID, in.Body.FromAccount)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO ticket_reply_drafts (ticket_id, user_id, workspace_id, body_html, body_text, attachment_ids,
						to_addresses, cc, bcc, mailbox_id, from_account)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
					ON CONFLICT (ticket_id, user_id) DO UPDATE SET body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text,
						attachment_ids = EXCLUDED.attachment_ids, to_addresses = EXCLUDED.to_addresses, cc = EXCLUDED.cc, bcc = EXCLUDED.bcc,
						mailbox_id = EXCLUDED.mailbox_id, from_account = EXCLUDED.from_account, updated_at = now()
					WHERE ticket_reply_drafts.send_at IS NULL`,
					tid, p.UserID, p.WorkspaceID, html, text, attIDs, r.to, r.cc, r.bcc, r.mailboxID, r.fromAccount); err != nil {
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
