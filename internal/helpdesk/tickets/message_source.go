package tickets

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/mailsource"
	"github.com/useopendesk/opendesk/internal/storage"
)

// messageSource opens the raw email a message came from (contracts/api.md, `GET /v1/messages/{id}/source`). It is
// the same visibility as the message: a hidden ticket, a deleted message (admins only) and
// a message that did not arrive by email, or whose source was purged, are 404.
func messageSource(ctx context.Context, d *deps.Deps, p *auth.Principal, rawID string) (io.ReadCloser, string, error) {
	id, err := hd.ParseID(rawID, "Message")
	if err != nil {
		return nil, "", err
	}
	var tid uuid.UUID
	var key, subject string
	err = d.DB.Pool.QueryRow(ctx, `SELECT t.id, ie.raw_storage_key, m.subject FROM messages m
		JOIN tickets t ON t.id = m.ticket_id AND t.deleted_at IS NULL
		JOIN inbound_emails ie ON ie.workspace_id = m.workspace_id AND ie.id = m.inbound_email_id
		WHERE m.workspace_id = $1 AND m.id = $2 AND (m.deleted_at IS NULL OR $3) AND ie.raw_storage_key <> ''`,
		p.WorkspaceID, id, p.Role.AtLeast(auth.RoleAdmin)).Scan(&tid, &key, &subject)
	if db.IsNotFound(err) {
		return nil, "", httpx.NotFound("Message source")
	}
	if err != nil {
		return nil, "", httpx.Wrap(err)
	}
	if _, err := domain.ResolveVisibleTicket(ctx, d.DB.Pool, p, tid.String()); err != nil {
		return nil, "", httpx.NotFound("Message source")
	}
	rc, err := d.Storage.Get(ctx, key)
	if errors.Is(err, storage.ErrNotFound) {
		return nil, "", httpx.NotFound("Message source")
	}
	if err != nil {
		return nil, "", httpx.Wrap(err)
	}
	return rc, subject, nil
}

func registerMessageSource(d *deps.Deps, api huma.API) {
	tags := []string{"Tickets"}
	huma.Register(api, huma.Operation{OperationID: "get-message-source", Method: http.MethodGet, Path: "/v1/messages/{id}/source",
		Summary: "Show the original email of a message", Tags: tags,
		Description: "The raw message as received: its headers and body. Only an email that arrived at a mailbox has one."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body mailsource.MailSource }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rc, _, err := messageSource(ctx, d, p, in.ID)
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			src, err := mailsource.Read(rc)
			if err != nil {
				return nil, err
			}
			return &struct{ Body mailsource.MailSource }{src}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "download-message-source", Method: http.MethodGet, Path: "/v1/messages/{id}/source.eml",
		Summary: "Download the original email of a message", Tags: tags,
		Description: "The raw message as an .eml file, saved and never rendered."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*mailsource.File, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rc, subject, err := messageSource(ctx, d, p, in.ID)
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			raw, err := mailsource.ReadAll(rc)
			if err != nil {
				return nil, err
			}
			return mailsource.Download(raw, subject), nil
		})
}
