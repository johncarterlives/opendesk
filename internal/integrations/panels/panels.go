// Package panels is the ticket panels of the integrations area (contracts/integrations.md
// "Ticket panels"): read-only data about a ticket's contact, fetched from another product
// when the ticket is open and shown beside it. A panel is a kind of source:
//
//   - shopify: the contact's customer and last orders in a Shopify store, by email
//     (Admin GraphQL API, read_customers and read_orders). OpenDesk asks Shopify for a token
//     with the client ID and secret of an app installed on the shop (the client credentials
//     grant, renewed every 24 hours), or uses an Admin API token pasted once (an older app);
//   - http: a URL of the workspace's own that OpenDesk posts the contact and ticket to,
//     signed like webhooks, answering blocks (cards, labelled values, lists, notes) or, as
//     version 1 did, sections of labelled values (an ERP, billing, a CRM).
//
// Credentials and signing secrets are sealed with d.Box and never leave the server.
// Panels never write anywhere and never block the ticket: a failure is a quiet state.
package panels

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/netsafe"
)

const (
	// KindShopify and KindHTTP are the panel sources.
	KindShopify = "shopify"
	KindHTTP    = "http"

	// maxPerWorkspace bounds a workspace's panels.
	maxPerWorkspace = 10
	// fetchTimeout is the whole budget of one lookup: the ticket never waits longer.
	fetchTimeout = 3 * time.Second
	// cacheTTL keeps an answer for a ticket opened again soon; errTTL keeps a failure
	// shorter, so a product that is down is not asked again on every open.
	cacheTTL = time.Minute
	errTTL   = 15 * time.Second
	// lookupsPerMinute bounds the lookups one panel makes that the cache did not answer.
	lookupsPerMinute = 120
	// readingsPerMinute bounds the readings of tickets a workspace's http panels make together
	// that the cache did not keep, in each API process.
	readingsPerMinute = 60
)

// Panel is a workspace's ticket panel as the API shows it. The token or signing secret
// never leaves the server, and an http panel shows its URL's host only, since a path can
// carry a secret.
type Panel struct {
	ID          uuid.UUID `json:"id"`
	Kind        string    `json:"kind" enum:"shopify,http"`
	Name        string    `json:"name"`
	Host        string    `json:"host" doc:"shopify: the shop's myshopify.com domain; http: the URL's host"`
	Auth        string    `json:"auth,omitempty" enum:"client_credentials,access_token" doc:"shopify: client_credentials when OpenDesk asks Shopify for its token with the app's client ID and secret; access_token when a token was pasted"`
	ClientID    string    `json:"client_id,omitempty" doc:"shopify client_credentials: the app's client ID (not a secret)"`
	Fields      []string  `json:"fields" doc:"shopify: the fields of Shopify's answer tickets show, in catalogue order (the defaults until an admin chooses); http: empty"`
	OrdersShown int       `json:"orders_shown,omitempty" minimum:"1" maximum:"5" doc:"shopify: how many of the last orders show, 1 to 5"`
	// ReferencePattern is set for http panels only.
	ReferencePattern *string   `json:"reference_pattern,omitempty" doc:"http: the regular expression (RE2) that finds order and invoice numbers in the ticket for the request's ticket.references; empty finds none"`
	Enabled          bool      `json:"enabled"`
	Position         int       `json:"position"`
	Status           string    `json:"status" enum:"connected,error"`
	LastError        string    `json:"last_error"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// row is a stored panel; target is the shop domain or the URL. A shopify panel with a
// client ID seals its app's client secret, one without seals an access token.
type row struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Kind        string
	Name        string
	Target      string
	ClientID    string
	SecretEnc   []byte
	Fields      *[]string // nil: the defaults
	OrdersShown int
	RefPattern  *string // http: nil is DefaultReferencePattern, "" finds no reference
	Enabled     bool
	Position    int
	Status      string
	LastError   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func (x *row) api() Panel {
	p := Panel{ID: x.ID, Kind: x.Kind, Name: x.Name, Host: x.Target, Fields: x.shownFields(), Enabled: x.Enabled, Position: x.Position,
		Status: x.Status, LastError: x.LastError, CreatedAt: x.CreatedAt, UpdatedAt: x.UpdatedAt}
	if x.Kind == KindShopify {
		p.OrdersShown = x.OrdersShown
	} else {
		pattern := x.referencePattern()
		p.ReferencePattern = &pattern
	}
	switch {
	case x.Kind == KindHTTP:
		p.Host = hostOf(x.Target)
	case x.ClientID != "":
		p.Auth, p.ClientID = "client_credentials", x.ClientID
	default:
		p.Auth = "access_token"
	}
	return p
}

const rowSelect = `SELECT id, workspace_id, kind, name, target, client_id, secret_enc, fields, orders_shown, reference_pattern, enabled, position, status,
	last_error, created_at, updated_at FROM ticket_panels`

func scanRow(r pgx.Row) (*row, error) {
	var x row
	err := r.Scan(&x.ID, &x.WorkspaceID, &x.Kind, &x.Name, &x.Target, &x.ClientID, &x.SecretEnc, &x.Fields, &x.OrdersShown, &x.RefPattern, &x.Enabled, &x.Position, &x.Status,
		&x.LastError, &x.CreatedAt, &x.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &x, nil
}

func loadRow(ctx context.Context, q db.Querier, wid, id uuid.UUID) (*row, error) {
	return scanRow(q.QueryRow(ctx, rowSelect+` WHERE workspace_id = $1 AND id = $2`, wid, id))
}

func listRows(ctx context.Context, q db.Querier, wid uuid.UUID) ([]*row, error) {
	rows, err := q.Query(ctx, rowSelect+` WHERE workspace_id = $1 ORDER BY position, created_at`, wid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*row{}
	for rows.Next() {
		x, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// Service holds the outbound client, the caches of answers and of ticket readings, and the
// Shopify app tokens (one per process).
type Service struct {
	d        *deps.Deps
	http     *http.Client
	guard    netsafe.Guard
	cache    *ttlCache[cacheKey, Data]
	contexts *ttlCache[contextKey, ticketContext]
	tokens   *appTokens
	// shopifyBase is a shop's origin (https://<shop>); tests point it at a fake.
	shopifyBase func(shop string) string
}

var (
	servicesMu sync.Mutex
	services   = map[*deps.Deps]*Service{}
)

// For returns the service for d (one per process).
func For(d *deps.Deps) *Service {
	servicesMu.Lock()
	defer servicesMu.Unlock()
	if s := services[d]; s != nil {
		return s
	}
	dev := !d.Cfg.IsProduction()
	s := &Service{d: d, http: netsafe.Client(dev, fetchTimeout), guard: netsafe.Guard{Dev: dev}, cache: newTTLCache[cacheKey, Data](1000),
		contexts: newTTLCache[contextKey, ticketContext](1000),
		tokens:   newAppTokens(), shopifyBase: shopifyOrigin}
	services[d] = s
	return s
}

// Register adds the ticket panel routes.
func Register(d *deps.Deps, api huma.API, _ chi.Router) {
	For(d).registerRoutes(api)
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func requireAdminUser(ctx context.Context) (*auth.Principal, error) {
	p, err := auth.RequireWorkspace(ctx, auth.RoleAdmin, auth.ScopeSettingsWrite)
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if p.Kind != auth.KindUser {
		return nil, httpx.Forbidden() // a person connects another product's credentials
	}
	return p, nil
}

func parseID(raw, what string) (uuid.UUID, error) {
	id, ok := ids.Parse(raw)
	if !ok {
		return uuid.Nil, httpx.NotFound(what)
	}
	return id, nil
}

func wrapLoad(err error) error {
	if db.IsNotFound(err) {
		return httpx.NotFound("Ticket panel")
	}
	return httpx.Wrap(err)
}

func (s *Service) publish(ctx context.Context, tx pgx.Tx, typ string, wid uuid.UUID, data map[string]any) error {
	_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: wid, Type: typ, Data: data})
	return err
}

// newSecret is an http panel's signing secret, shown once.
func newSecret() string { return "pnsec_" + crypto.RandomToken(32) }

type panelBody struct {
	Body Panel
}

type createdBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		Panel  Panel  `json:"panel"`
		Secret string `json:"secret,omitempty" doc:"http panels: the signing secret, shown once"`
	}
}

func (s *Service) registerRoutes(api huma.API) {
	tags := []string{"Ticket panels"}

	huma.Register(api, huma.Operation{OperationID: "list-ticket-panels", Method: http.MethodGet, Path: "/v1/ticket-panels",
		Summary: "List the workspace's ticket panels", Tags: tags},
		func(ctx context.Context, _ *struct{}) (*struct {
			Body struct {
				Data []Panel `json:"data"`
			}
		}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			rows, err := listRows(ctx, s.d.DB.Pool, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := &struct {
				Body struct {
					Data []Panel `json:"data"`
				}
			}{}
			out.Body.Data = make([]Panel, 0, len(rows))
			for _, x := range rows {
				out.Body.Data = append(out.Body.Data, x.api())
			}
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "create-ticket-panel", Method: http.MethodPost, Path: "/v1/ticket-panels",
		Summary: "Add a ticket panel", Tags: tags, DefaultStatus: http.StatusCreated,
		Description: "`shopify` needs `shop` and either `client_id` and `client_secret` (an app installed on the shop) or `token` (an Admin API access token), checked with the shop first; `http` needs `url` and answers its signing `secret` once."},
		func(ctx context.Context, in *struct {
			Body struct {
				Kind             string   `json:"kind" enum:"shopify,http"`
				Name             string   `json:"name,omitempty" maxLength:"64"`
				Shop             string   `json:"shop,omitempty" maxLength:"255" doc:"shopify: the shop's myshopify.com domain or handle"`
				ClientID         string   `json:"client_id,omitempty" maxLength:"255" doc:"shopify: the client ID of an app installed on the shop"`
				ClientSecret     string   `json:"client_secret,omitempty" maxLength:"4096" doc:"shopify: that app's client secret"`
				Token            string   `json:"token,omitempty" maxLength:"4096" doc:"shopify: an Admin API access token, in place of a client ID and secret (apps made before 2026)"`
				URL              string   `json:"url,omitempty" maxLength:"2000" doc:"http: the https URL OpenDesk posts to"`
				Fields           []string `json:"fields,omitempty" maxItems:"12" enum:"tags,email,orders_count,total_spent,financial_status,fulfillment_status,line_items,line_prices,shipping,discounts,refunds,tracking" doc:"shopify: the fields tickets show (default: all but email)"`
				OrdersShown      *int     `json:"orders_shown,omitempty" minimum:"1" maximum:"5" doc:"shopify: how many of the last orders show (default 5)"`
				ReferencePattern *string  `json:"reference_pattern,omitempty" maxLength:"200" doc:"http: the regular expression (RE2) that finds the ticket's references (default: DefaultReferencePattern; empty finds none)"`
			}
		}) (*createdBody, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			if !s.d.Limiter.Allow("ticket-panel:create:"+p.WorkspaceID.String(), 30, time.Hour) {
				return nil, httpx.E(http.StatusTooManyRequests, "rate_limited", "Too many attempts. Try again later.")
			}
			b := in.Body
			x := &row{ID: ids.New(), WorkspaceID: p.WorkspaceID, Kind: b.Kind, OrdersShown: defaultOrdersShown, Enabled: true, Status: "connected"}
			if b.Kind != KindShopify && (b.Fields != nil || b.OrdersShown != nil) {
				return nil, httpx.Validation("Only a Shopify panel has fields to choose.")
			}
			if b.Fields != nil {
				fields, err := normalizeFields(b.Fields)
				if err != nil {
					return nil, httpx.Validation(err.Error())
				}
				x.Fields = &fields
			}
			if b.OrdersShown != nil {
				x.OrdersShown = *b.OrdersShown
			}
			if b.ReferencePattern != nil {
				if b.Kind != KindHTTP {
					return nil, httpx.Validation("Only an http panel finds references.")
				}
				if x.RefPattern, err = normalizePattern(*b.ReferencePattern); err != nil {
					return nil, httpx.Validation(err.Error())
				}
			}
			out := &createdBody{CacheControl: "no-store"}
			switch b.Kind {
			case KindShopify:
				if x.Target, err = normalizeShop(b.Shop); err != nil {
					return nil, httpx.Validation(err.Error())
				}
				c, err := shopifyCredentials(b.ClientID, b.ClientSecret, b.Token)
				if err != nil {
					return nil, httpx.Validation(err.Error())
				}
				shopName, err := s.checkShopify(ctx, x.Target, c)
				if err != nil {
					return nil, httpx.E(422, "panel_failed", "Couldn't connect to Shopify: "+clip(err.Error(), 300))
				}
				x.Name, x.ClientID = shopName, c.clientID
				if x.SecretEnc, err = s.d.Box.Seal([]byte(c.secret)); err != nil {
					return nil, httpx.Wrap(err)
				}
			case KindHTTP:
				if x.Target, err = s.guard.ValidateURL(ctx, b.URL); err != nil {
					return nil, httpx.E(422, "invalid_url", err.Error())
				}
				x.Name = hostOf(x.Target)
				out.Body.Secret = newSecret()
				if x.SecretEnc, err = s.d.Box.Seal([]byte(out.Body.Secret)); err != nil {
					return nil, httpx.Wrap(err)
				}
			default:
				return nil, httpx.Validation("A panel is shopify or http.")
			}
			if strings.TrimSpace(b.Name) != "" {
				if x.Name, err = displayname.Validate("Name", b.Name, displayname.Workspace, false); err != nil {
					return nil, httpx.Wrap(err)
				}
			}
			if x.Name == "" {
				x.Name = map[string]string{KindShopify: "Shopify", KindHTTP: "Panel"}[x.Kind]
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var n int
				if err := tx.QueryRow(ctx, `SELECT count(*), COALESCE(max(position) + 1, 0) FROM ticket_panels WHERE workspace_id = $1`,
					p.WorkspaceID).Scan(&n, &x.Position); err != nil {
					return err
				}
				if n >= maxPerWorkspace {
					return httpx.Conflict("A workspace can have at most 10 ticket panels.")
				}
				if _, err := tx.Exec(ctx, `INSERT INTO ticket_panels (id, workspace_id, kind, name, target, client_id, secret_enc, fields, orders_shown,
					reference_pattern, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, x.ID, p.WorkspaceID, x.Kind, x.Name, x.Target,
					x.ClientID, x.SecretEnc, x.Fields, x.OrdersShown, x.RefPattern, x.Position, p.ActorUserID()); err != nil {
					return err
				}
				saved, err := loadRow(ctx, tx, p.WorkspaceID, x.ID)
				if err != nil {
					return err
				}
				*x = *saved
				if err := s.publish(ctx, tx, "ticket_panel.created", p.WorkspaceID, map[string]any{"panel": x.api()}); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "ticket_panel.connected", "ticket_panel", &x.ID,
					map[string]any{"kind": x.Kind, "host": x.api().Host})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out.Body.Panel = x.api()
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-ticket-panel", Method: http.MethodPatch, Path: "/v1/ticket-panels/{id}",
		Summary: "Change a ticket panel", Tags: tags},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Name             *string  `json:"name,omitempty" maxLength:"64"`
				Enabled          *bool    `json:"enabled,omitempty"`
				Position         *int     `json:"position,omitempty" minimum:"0" maximum:"100"`
				ClientID         *string  `json:"client_id,omitempty" maxLength:"255" doc:"shopify: another app's client ID, with its client_secret"`
				ClientSecret     *string  `json:"client_secret,omitempty" maxLength:"4096" doc:"shopify: the app's new client secret (the client ID stays unless given), checked with the shop first"`
				Token            *string  `json:"token,omitempty" maxLength:"4096" doc:"shopify: an access token in place of the app's credentials, checked with the shop first"`
				URL              *string  `json:"url,omitempty" maxLength:"2000" doc:"http: a new URL"`
				Fields           []string `json:"fields,omitempty" maxItems:"12" enum:"tags,email,orders_count,total_spent,financial_status,fulfillment_status,line_items,line_prices,shipping,discounts,refunds,tracking" doc:"shopify: the fields tickets show, all of them listed ([] shows the name, number, date and total only)"`
				OrdersShown      *int     `json:"orders_shown,omitempty" minimum:"1" maximum:"5" doc:"shopify: how many of the last orders show"`
				ReferencePattern *string  `json:"reference_pattern,omitempty" maxLength:"200" doc:"http: the regular expression (RE2) that finds the ticket's references; the default pattern puts the default back, empty finds none"`
			}
		}) (*panelBody, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			id, err := parseID(in.ID, "Ticket panel")
			if err != nil {
				return nil, err
			}
			x, err := loadRow(ctx, s.d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, wrapLoad(err)
			}
			b := in.Body
			changes := []string{}
			if b.Name != nil {
				if x.Name, err = displayname.Validate("Name", *b.Name, displayname.Workspace, false); err != nil {
					return nil, httpx.Wrap(err)
				}
				changes = append(changes, "name")
			}
			if b.Enabled != nil {
				x.Enabled = *b.Enabled
				changes = append(changes, "enabled")
			}
			if b.Position != nil {
				x.Position = *b.Position
				changes = append(changes, "position")
			}
			if (b.Fields != nil || b.OrdersShown != nil) && x.Kind != KindShopify {
				return nil, httpx.Validation("Only a Shopify panel has fields to choose.")
			}
			if b.Fields != nil {
				fields, err := normalizeFields(b.Fields)
				if err != nil {
					return nil, httpx.Validation(err.Error())
				}
				x.Fields = &fields
				changes = append(changes, "fields")
			}
			if b.OrdersShown != nil {
				x.OrdersShown = *b.OrdersShown
				changes = append(changes, "orders_shown")
			}
			if b.ReferencePattern != nil {
				if x.Kind != KindHTTP {
					return nil, httpx.Validation("Only an http panel finds references.")
				}
				if x.RefPattern, err = normalizePattern(*b.ReferencePattern); err != nil {
					return nil, httpx.Validation(err.Error())
				}
				changes = append(changes, "reference_pattern")
			}
			if b.ClientID != nil || b.ClientSecret != nil || b.Token != nil {
				if x.Kind != KindShopify {
					return nil, httpx.Validation("Only a Shopify panel has credentials.")
				}
				var c shopifyCred
				if b.Token != nil {
					c, err = shopifyCredentials(deref(b.ClientID), deref(b.ClientSecret), *b.Token)
				} else {
					// A rotated secret keeps the app's client ID.
					clientID := x.ClientID
					if b.ClientID != nil {
						clientID = *b.ClientID
					}
					c, err = shopifyCredentials(clientID, deref(b.ClientSecret), "")
				}
				if err != nil {
					return nil, httpx.Validation(err.Error())
				}
				if _, err := s.checkShopify(ctx, x.Target, c); err != nil {
					return nil, httpx.E(422, "panel_failed", "Couldn't connect to Shopify: "+clip(err.Error(), 300))
				}
				if x.SecretEnc, err = s.d.Box.Seal([]byte(c.secret)); err != nil {
					return nil, httpx.Wrap(err)
				}
				x.ClientID = c.clientID
				x.Status, x.LastError = "connected", ""
				changes = append(changes, "credentials")
			}
			if b.URL != nil {
				if x.Kind != KindHTTP {
					return nil, httpx.Validation("Only an http panel has a URL.")
				}
				if x.Target, err = s.guard.ValidateURL(ctx, *b.URL); err != nil {
					return nil, httpx.E(422, "invalid_url", err.Error())
				}
				x.Status, x.LastError = "connected", ""
				changes = append(changes, "url")
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `UPDATE ticket_panels SET name = $3, enabled = $4, position = $5, target = $6,
					client_id = $7, secret_enc = $8, status = $9, last_error = $10, fields = $11, orders_shown = $12, reference_pattern = $13,
					updated_at = now() WHERE workspace_id = $1 AND id = $2`,
					p.WorkspaceID, id, x.Name, x.Enabled, x.Position, x.Target, x.ClientID, x.SecretEnc, x.Status, x.LastError, x.Fields, x.OrdersShown,
					x.RefPattern); err != nil {
					return err
				}
				saved, err := loadRow(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				*x = *saved
				if err := s.publish(ctx, tx, "ticket_panel.updated", p.WorkspaceID, map[string]any{"panel": x.api()}); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "ticket_panel.updated", "ticket_panel", &x.ID,
					map[string]any{"kind": x.Kind, "host": x.api().Host, "changes": changes})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &panelBody{x.api()}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "rotate-ticket-panel-secret", Method: http.MethodPost,
		Path: "/v1/ticket-panels/{id}/rotate-secret", Summary: "Replace an http panel's signing secret", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*createdBody, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			id, err := parseID(in.ID, "Ticket panel")
			if err != nil {
				return nil, err
			}
			x, err := loadRow(ctx, s.d.DB.Pool, p.WorkspaceID, id)
			if err != nil {
				return nil, wrapLoad(err)
			}
			if x.Kind != KindHTTP {
				return nil, httpx.Validation("Only an http panel has a signing secret.")
			}
			out := &createdBody{CacheControl: "no-store"}
			out.Body.Secret = newSecret()
			sealed, err := s.d.Box.Seal([]byte(out.Body.Secret))
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `UPDATE ticket_panels SET secret_enc = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
					p.WorkspaceID, id, sealed); err != nil {
					return err
				}
				saved, err := loadRow(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				*x = *saved
				if err := s.publish(ctx, tx, "ticket_panel.updated", p.WorkspaceID, map[string]any{"panel": x.api()}); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "ticket_panel.updated", "ticket_panel", &x.ID,
					map[string]any{"kind": x.Kind, "host": x.api().Host, "changes": []string{"secret"}})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out.Body.Panel = x.api()
			return out, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-ticket-panel", Method: http.MethodDelete, Path: "/v1/ticket-panels/{id}",
		Summary: "Remove a ticket panel", Tags: tags, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := requireAdminUser(ctx)
			if err != nil {
				return nil, err
			}
			id, err := parseID(in.ID, "Ticket panel")
			if err != nil {
				return nil, err
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				x, err := loadRow(ctx, tx, p.WorkspaceID, id)
				if err != nil {
					return wrapLoad(err)
				}
				if _, err := tx.Exec(ctx, `DELETE FROM ticket_panels WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id); err != nil {
					return err
				}
				if err := s.publish(ctx, tx, "ticket_panel.deleted", p.WorkspaceID, map[string]any{"panel_id": id}); err != nil {
					return err
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "ticket_panel.disconnected", "ticket_panel", &id,
					map[string]any{"kind": x.Kind, "host": x.api().Host})
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			s.cache.forget(id)
			s.contexts.forget(id)
			s.tokens.forget(id)
			return nil, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-ticket-panel", Method: http.MethodGet, Path: "/v1/tickets/{id}/panels/{panelId}",
		Summary: "Read a ticket panel for a ticket", Tags: []string{"Tickets"},
		Description: "What the panel's product knows about the ticket's contact. A failure is a `state`, never an error status: the ticket never waits on another product."},
		func(ctx context.Context, in *struct {
			ID      string `path:"id"`
			PanelID string `path:"panelId"`
			Refresh bool   `query:"refresh" doc:"Ask the product again rather than answer from the last minute's copy"`
		}) (*struct{ Body Data }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			tid, err := parseID(in.ID, "Ticket")
			if err != nil {
				return nil, err
			}
			pid, err := parseID(in.PanelID, "Ticket panel")
			if err != nil {
				return nil, err
			}
			t, err := domain.LoadVisibleTicket(ctx, s.d.DB.Pool, p, tid)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Ticket")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			x, err := loadRow(ctx, s.d.DB.Pool, p.WorkspaceID, pid)
			if err != nil {
				return nil, wrapLoad(err)
			}
			if !x.Enabled {
				return nil, httpx.NotFound("Ticket panel")
			}
			data := s.read(ctx, x, &t, in.Refresh)
			return &struct{ Body Data }{data}, nil
		})
}

// errAuth marks a refusal of the panel's credentials: the panel shows as needing attention
// in settings until new credentials or a new URL are saved, or a lookup succeeds again.
var errAuth = errors.New("credentials refused")

// authError is a refusal of the stored credentials with the product's words.
type authError struct{ msg string }

func (e *authError) Error() string { return e.msg }
func (e *authError) Is(target error) bool {
	return target == errAuth
}

// markStatus records a refused credential, or a lookup that works again, publishing the
// change. Other failures (a timeout, an outage) leave the status as it is, and so does a lookup
// made with a configuration saved over since (updated_at moved).
func (s *Service) markStatus(ctx context.Context, x *row, lookupErr error) {
	status, last := "connected", ""
	switch {
	case errors.Is(lookupErr, errAuth):
		status, last = "error", clip(lookupErr.Error(), 300)
	case lookupErr != nil:
		return
	}
	if status == x.Status && last == x.LastError {
		return
	}
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE ticket_panels SET status = $3, last_error = $4 WHERE workspace_id = $1 AND id = $2
			AND updated_at = $5 AND (status <> $3 OR last_error <> $4)`, x.WorkspaceID, x.ID, status, last, x.UpdatedAt)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		x.Status, x.LastError = status, last
		return s.publish(ctx, tx, "ticket_panel.updated", x.WorkspaceID, map[string]any{"panel": x.api()})
	})
	if err != nil {
		s.d.Log.Warn("ticket panel status", "panel", x.ID, "err", err)
	}
}
