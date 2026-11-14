package tickets

// The trash: deleted tickets, and the way back (contracts/api.md "Trash").
//
//	GET  /v1/tickets/deleted          the workspace's deleted tickets, newest first, with who
//	                                  deleted each and when (Settings → Trash)
//	POST /v1/tickets/{id}/restore     brings one back as it was
//
// Admins only: agents delete, admins can undo it. A ticket of a private team the caller does not
// see stays out, as everywhere else.

import (
	"context"
	"fmt"
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
	"github.com/useopendesk/opendesk/internal/httpx"
)

// DeletedTicketRef names who deleted a ticket, or its customer.
type DeletedTicketRef struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Email string    `json:"email,omitempty"`
}

// DeletedTicket is a row of the trash.
type DeletedTicket struct {
	ID              uuid.UUID         `json:"id"`
	Number          int64             `json:"number"`
	Subject         string            `json:"subject"`
	Status          string            `json:"status"`
	Channel         string            `json:"channel"`
	Contact         *DeletedTicketRef `json:"contact"`
	MessageCount    int               `json:"message_count"`
	DeletedAt       time.Time         `json:"deleted_at"`
	DeletedBy       *DeletedTicketRef `json:"deleted_by" doc:"The member who deleted it; null for an API key, an automation, or a ticket deleted before this was recorded."`
	DeletedByAPIKey *DeletedTicketRef `json:"deleted_by_api_key" doc:"The API key that deleted it."`
	// A ticket merged into another was emptied by the merge: its conversation lives on that ticket.
	MergedIntoNumber *int64 `json:"merged_into_number"`
}

// cursor is where a page of the trash ends: (deleted_at, id), since a bulk delete stamps one time.
func trashCursor(t DeletedTicket) string {
	return t.DeletedAt.UTC().Format(time.RFC3339Nano) + "_" + t.ID.String()
}

func parseTrashCursor(s string) (time.Time, uuid.UUID, error) {
	at, id, ok := strings.Cut(s, "_")
	if !ok {
		return time.Time{}, uuid.Nil, httpx.Validation("before: not a cursor from next_before")
	}
	ts, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return time.Time{}, uuid.Nil, httpx.Validation("before: not a cursor from next_before")
	}
	u, err := uuid.Parse(id)
	if err != nil {
		return time.Time{}, uuid.Nil, httpx.Validation("before: not a cursor from next_before")
	}
	return ts, u, nil
}

func registerTrash(d *deps.Deps, api huma.API) {
	tags := []string{"Tickets"}
	type listOut struct {
		Body struct {
			Data       []DeletedTicket `json:"data"`
			NextBefore string          `json:"next_before,omitempty" doc:"Pass as before for the next page; absent on the last page."`
		}
	}
	huma.Register(api, huma.Operation{OperationID: "list-deleted-tickets", Method: http.MethodGet, Path: "/v1/tickets/deleted",
		Summary: "List deleted tickets", Tags: tags,
		Description: "Admins only. Newest deletion first. q matches the number or the subject."},
		func(ctx context.Context, in *struct {
			Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"100"`
			Before string `query:"before"`
			Q      string `query:"q"`
		}) (*listOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var beforeAt *time.Time
			beforeID := uuid.Nil
			if in.Before != "" {
				at, id, err := parseTrashCursor(in.Before)
				if err != nil {
					return nil, err
				}
				beforeAt, beforeID = &at, id
			}
			q := strings.TrimPrefix(strings.TrimSpace(in.Q), "#")
			hidden, err := domain.HiddenTeams(ctx, d.DB.Pool, p)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			me := uuid.Nil
			if u := p.ActorUserID(); u != nil {
				me = *u
			}
			out := &listOut{}
			out.Body.Data = []DeletedTicket{}
			// One more than asked, to know whether a next page exists.
			rows, err := d.DB.Pool.Query(ctx, `SELECT t.id, t.number, t.subject, t.status, t.channel, t.deleted_at,
				c.id, coalesce(c.name, ''), coalesce(c.email, ''),
				(SELECT count(*) FROM messages m WHERE m.workspace_id = t.workspace_id AND m.ticket_id = t.id AND m.deleted_at IS NULL),
				u.id, coalesce(u.name, ''), coalesce(u.email, ''), k.id, coalesce(k.name, ''), mt.number
				FROM tickets t
				LEFT JOIN contacts c ON c.id = t.contact_id
				LEFT JOIN users u ON u.id = t.deleted_by
				LEFT JOIN api_keys k ON k.id = t.deleted_by_api_key_id
				LEFT JOIN tickets mt ON mt.id = t.merged_into_id
				WHERE t.workspace_id = $1 AND t.deleted_at IS NOT NULL
				  AND ($2::timestamptz IS NULL OR (t.deleted_at, t.id) < ($2, $3))
				  AND ($4 = '' OR t.number::text = $4 OR t.subject ILIKE '%' || $4 || '%')
				  AND `+domain.VisibleSQLUser("t", 6, 7)+`
				ORDER BY t.deleted_at DESC, t.id DESC LIMIT $5`,
				p.WorkspaceID, beforeAt, beforeID, q, in.Limit+1, hidden, me)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			defer rows.Close()
			for rows.Next() {
				var t DeletedTicket
				var cid, uid, kid *uuid.UUID
				var cname, cemail, uname, uemail, kname string
				if err := rows.Scan(&t.ID, &t.Number, &t.Subject, &t.Status, &t.Channel, &t.DeletedAt,
					&cid, &cname, &cemail, &t.MessageCount, &uid, &uname, &uemail, &kid, &kname, &t.MergedIntoNumber); err != nil {
					return nil, httpx.Wrap(err)
				}
				if cid != nil {
					t.Contact = &DeletedTicketRef{ID: *cid, Name: cname, Email: cemail}
				}
				if uid != nil {
					t.DeletedBy = &DeletedTicketRef{ID: *uid, Name: uname, Email: uemail}
				}
				if kid != nil {
					t.DeletedByAPIKey = &DeletedTicketRef{ID: *kid, Name: kname}
				}
				out.Body.Data = append(out.Body.Data, t)
			}
			if err := rows.Err(); err != nil {
				return nil, httpx.Wrap(err)
			}
			if len(out.Body.Data) > in.Limit {
				out.Body.Data = out.Body.Data[:in.Limit]
				out.Body.NextBefore = trashCursor(out.Body.Data[in.Limit-1])
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "restore-ticket", Method: http.MethodPost, Path: "/v1/tickets/{id}/restore",
		Summary: "Restore a deleted ticket", Tags: tags,
		Description: "Admins only. id is the uuid or the number. The ticket comes back as it was, in lists, views and search. A ticket merged into another is refused (409): its conversation lives there."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*ticketOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeTicketsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			var t domain.Ticket
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				r, err := deletedTicket(ctx, tx, p, in.ID)
				if err != nil {
					return err
				}
				if err := restoreTicket(ctx, tx, p, r); err != nil {
					return err
				}
				t, err = domain.LoadTicket(ctx, tx, p.WorkspaceID, r.ID)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &ticketOut{Body: t}, nil
		})
}

// deletedTicket finds a deleted ticket the caller may see, by uuid or number, locked for the restore.
func deletedTicket(ctx context.Context, tx pgx.Tx, p *auth.Principal, ref string) (restoreTarget, error) {
	var r restoreTarget
	ref = strings.TrimSpace(ref)
	by, key := "id", any(nil)
	if id, err := uuid.Parse(ref); err == nil {
		key = id
	} else if m := domain.TicketNumberRef.FindStringSubmatch(ref); m != nil {
		n, _ := strconv.ParseInt(m[1], 10, 64)
		by, key = "number", n
	} else {
		return r, httpx.NotFound("Deleted ticket")
	}
	var team, assignee, merged *uuid.UUID
	var deleted bool
	err := tx.QueryRow(ctx, `SELECT id, number, deleted_at IS NOT NULL, merged_into_id, team_id, assignee_id
		FROM tickets WHERE workspace_id = $1 AND `+by+` = $2 FOR UPDATE`, p.WorkspaceID, key).
		Scan(&r.ID, &r.Number, &deleted, &merged, &team, &assignee)
	if db.IsNotFound(err) || (err == nil && !deleted) {
		return r, httpx.NotFound("Deleted ticket")
	}
	if err != nil {
		return r, err
	}
	if ok, err := domain.CanSee(ctx, tx, p, team, assignee); err != nil {
		return r, err
	} else if !ok {
		return r, httpx.NotFound("Deleted ticket")
	}
	if merged != nil {
		var into int64
		if err := tx.QueryRow(ctx, `SELECT number FROM tickets WHERE id = $1`, *merged).Scan(&into); err != nil {
			return r, err
		}
		return r, httpx.Conflict(fmt.Sprintf("This ticket was merged into #%d: its conversation lives there.", into))
	}
	return r, nil
}

type restoreTarget struct {
	ID     uuid.UUID
	Number int64
}

// restoreTicket brings a deleted ticket back as it was: in lists, views and search again, with a
// "restored" entry on its timeline and in the audit log, published as updated so every open app
// shows it.
func restoreTicket(ctx context.Context, tx pgx.Tx, p *auth.Principal, r restoreTarget) error {
	if _, err := tx.Exec(ctx, `UPDATE tickets SET deleted_at = NULL, deleted_by = NULL, deleted_by_api_key_id = NULL, updated_at = now()
		WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, p.WorkspaceID, r.ID); err != nil {
		return err
	}
	actor := actorOf(p)
	if _, err := domain.LogActivity(ctx, tx, p.WorkspaceID, r.ID, actor.Type, actor.UserID, "restored", nil); err != nil {
		return err
	}
	id := r.ID
	if err := audit.Log(ctx, tx, p, p.WorkspaceID, "ticket.restored", "ticket", &id, map[string]any{"number": r.Number}); err != nil {
		return err
	}
	return domain.PublishTicketUpdated(ctx, tx, p.WorkspaceID, r.ID, []string{"deleted_at"})
}
