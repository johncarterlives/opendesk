package customerportal

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/emails"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

// Invitations (contracts/customer-portal.md "Invitations"): a member sends a contact a
// one-time link to choose a portal password, sees whether the contact has access, and can
// take it away. An invitation is a password link with a longer life and its own wording.

const (
	// inviteDays is how long an invitation's link works.
	inviteDays = 7
	// linksPerContactHour bounds password links per contact, requested or invited.
	linksPerContactHour = 5
	// invitesPerMemberHour bounds the invitations one member (or API key) sends.
	invitesPerMemberHour = 200
	// invitesPerWorkspaceHour bounds the invitations one workspace sends.
	invitesPerWorkspaceHour = 500
	// bulkInviteMax bounds the contacts one bulk invitation names.
	bulkInviteMax = 100
)

// Portal access states (PortalAccess.Status).
const (
	accessNone    = "none"
	accessInvited = "invited"
	accessActive  = "active"
)

// PortalBrand is a brand whose help center is on: where an invitation can lead.
type PortalBrand struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Slug     string    `json:"slug"`
	AuthMode string    `json:"auth_mode" enum:"local,oidc,local_and_oidc"`
	Default  bool      `json:"default"`
}

// PortalAccess is a contact's customer portal access, as members see it.
type PortalAccess struct {
	Status          string        `json:"status" enum:"none,invited,active" doc:"active: a password or a provider sign-in; invited: a password link that is still open; none: neither"`
	Password        bool          `json:"password" doc:"The contact has chosen a password"`
	SSO             bool          `json:"sso" doc:"The contact signs in through a brand's identity provider"`
	InvitedAt       *time.Time    `json:"invited_at" doc:"When the newest open password link was sent"`
	InviteExpiresAt *time.Time    `json:"invite_expires_at"`
	LastSignInAt    *time.Time    `json:"last_sign_in_at"`
	Brands          []PortalBrand `json:"brands" doc:"Brands whose help center is on, the default brand first"`
}

func (s *service) registerInvites(api huma.API) {
	tags := []string{"Customer portal"}
	huma.Register(api, huma.Operation{OperationID: "get-contact-portal-access", Method: http.MethodGet, Path: "/v1/contacts/{id}/portal",
		Summary: "Get a contact's customer portal access", Tags: tags},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body PortalAccess }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeContactsRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			cid, err := uuid.Parse(in.ID)
			if err != nil {
				return nil, httpx.NotFound("Contact")
			}
			out, err := s.portalAccess(ctx, s.d.DB.Pool, p.WorkspaceID, cid)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body PortalAccess }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "invite-contact-to-portal", Method: http.MethodPost, Path: "/v1/contacts/{id}/portal/invite",
		Summary: "Invite a contact to the customer portal", Tags: tags,
		Description: "Emails the contact a one-time link to choose a portal password, from the brand's help center (default: the default brand's, else the only one that is on). The link works for 7 days."},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				BrandID *uuid.UUID `json:"brand_id,omitempty" doc:"The brand whose portal the invitation is for"`
			}
		}) (*struct{ Body PortalAccess }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			cid, err := uuid.Parse(in.ID)
			if err != nil {
				return nil, httpx.NotFound("Contact")
			}
			var out PortalAccess
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				brand, err := s.inviteBrand(ctx, tx, p.WorkspaceID, in.Body.BrandID)
				if err != nil {
					return err
				}
				switch why, err := s.invite(ctx, tx, p, brand, cid); {
				case err != nil:
					return err
				case why == skipNotFound:
					return httpx.NotFound("Contact")
				case why == skipNoEmail:
					return httpx.E(http.StatusUnprocessableEntity, "no_email", "Give the contact an email address first.")
				case why == skipBlocked:
					return httpx.E(http.StatusUnprocessableEntity, "contact_blocked", "This contact is blocked. Unblock them first.")
				case why == skipRateLimited:
					return httpx.E(http.StatusTooManyRequests, "rate_limited", "Several links went to this contact in the last hour. Try again later.")
				case why == skipSenderLimited:
					return httpx.E(http.StatusTooManyRequests, "sender_rate_limited", "You sent many invitations in the last hour. Try again later.")
				case why == skipWorkspaceLimited:
					return httpx.E(http.StatusTooManyRequests, "workspace_rate_limited", "Your workspace sent many invitations in the last hour. Try again later.")
				}
				out, err = s.portalAccess(ctx, tx, p.WorkspaceID, cid)
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body PortalAccess }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "invite-contacts-to-portal", Method: http.MethodPost, Path: "/v1/contacts/portal/invite",
		Summary: "Invite contacts to the customer portal", Tags: tags,
		Description: "Invites up to 100 contacts at once, as the single invitation does. Contacts without an email address, blocked ones, ones who already have access and ones who had several links in the last hour are skipped and counted, as are the rest once the sender's or the workspace's hourly invitation limit is reached."},
		func(ctx context.Context, in *struct {
			Body struct {
				IDs     []uuid.UUID `json:"ids" minItems:"1" maxItems:"100"`
				BrandID *uuid.UUID  `json:"brand_id,omitempty"`
			}
		}) (*struct{ Body bulkInviteResult }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out := bulkInviteResult{Skipped: map[string]int{}}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				brand, err := s.inviteBrand(ctx, tx, p.WorkspaceID, in.Body.BrandID)
				if err != nil {
					return err
				}
				seen := map[uuid.UUID]bool{}
				for _, cid := range in.Body.IDs {
					if seen[cid] {
						continue
					}
					seen[cid] = true
					var active bool
					if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM customer_credentials WHERE workspace_id=$1 AND contact_id=$2)
						OR EXISTS (SELECT 1 FROM customer_oidc_identities WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL)`,
						p.WorkspaceID, cid).Scan(&active); err != nil {
						return err
					}
					if active {
						out.Skipped[skipActive]++
						continue
					}
					why, err := s.invite(ctx, tx, p, brand, cid)
					if err != nil {
						return err
					}
					if why != "" {
						out.Skipped[why]++
						continue
					}
					out.Sent++
				}
				return nil
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body bulkInviteResult }{out}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "remove-contact-portal-access", Method: http.MethodDelete, Path: "/v1/contacts/{id}/portal",
		Summary: "Remove a contact's customer portal access", Tags: tags,
		Description: "Removes the contact's portal password, signs out every portal session and closes every open password link. A contact who signs in through a brand's identity provider can sign in again there; block the contact to keep them out."},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeContactsWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			cid, err := uuid.Parse(in.ID)
			if err != nil {
				return nil, httpx.NotFound("Contact")
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var found bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM contacts WHERE workspace_id=$1 AND id=$2)`, p.WorkspaceID, cid).Scan(&found); err != nil {
					return err
				}
				if !found {
					return httpx.NotFound("Contact")
				}
				for _, q := range []string{
					`DELETE FROM customer_credentials WHERE workspace_id=$1 AND contact_id=$2`,
					`UPDATE customer_sessions SET revoked_at=now() WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL`,
					`UPDATE customer_password_resets SET used_at=now() WHERE workspace_id=$1 AND contact_id=$2 AND used_at IS NULL`,
				} {
					if _, err := tx.Exec(ctx, q, p.WorkspaceID, cid); err != nil {
						return err
					}
				}
				return audit.Log(ctx, tx, p, p.WorkspaceID, "contact.portal_access_removed", "contact", &cid, nil)
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}

type bulkInviteResult struct {
	Sent    int            `json:"sent"`
	Skipped map[string]int `json:"skipped" doc:"Contacts left out, by reason: no_email, blocked, active (already has access), rate_limited (the contact's links), sender_rate_limited, workspace_rate_limited, not_found"`
}

// Why an invitation was not sent (bulkInviteResult.Skipped keys).
const (
	skipNotFound    = "not_found"
	skipNoEmail     = "no_email"
	skipBlocked     = "blocked"
	skipActive      = "active"
	skipRateLimited = "rate_limited"
	// skipSenderLimited and skipWorkspaceLimited: the member's (or API key's) or the
	// workspace's invitations in the last hour reached their limit.
	skipSenderLimited    = "sender_rate_limited"
	skipWorkspaceLimited = "workspace_rate_limited"
)

// inviteBrand is the brand an invitation is from: the one asked for, else the default
// brand when its help center is on, else the only brand whose help center is on. Its
// customers must be able to choose a password.
func (s *service) inviteBrand(ctx context.Context, tx pgx.Tx, wid uuid.UUID, want *uuid.UUID) (PortalBrand, error) {
	brands, err := portalBrands(ctx, tx, wid)
	if err != nil {
		return PortalBrand{}, err
	}
	var pick *PortalBrand
	for i, b := range brands {
		if (want != nil && b.ID == *want) || (want == nil && (b.Default || len(brands) == 1)) {
			pick = &brands[i]
			break
		}
	}
	if pick == nil {
		if want != nil {
			return PortalBrand{}, httpx.E(http.StatusUnprocessableEntity, "help_center_off", "That brand's help center is off, so it has no customer portal.")
		}
		if len(brands) == 0 {
			return PortalBrand{}, httpx.E(http.StatusUnprocessableEntity, "help_center_off", "Turn on a help center first: the customer portal is part of it.")
		}
		return PortalBrand{}, httpx.E(http.StatusUnprocessableEntity, "brand_required", "Choose which brand's portal the invitation is for.")
	}
	if pick.AuthMode == "oidc" {
		return PortalBrand{}, httpx.E(http.StatusUnprocessableEntity, "password_sign_in_off",
			"Customers of this brand sign in through its identity provider, with no password to choose. They can sign in there without an invitation.")
	}
	return *pick, nil
}

// portalBrands are the workspace's brands whose help center is on, the default first.
func portalBrands(ctx context.Context, q db.Querier, wid uuid.UUID) ([]PortalBrand, error) {
	rows, err := q.Query(ctx, `SELECT id, name, slug, portal_auth_mode, is_default FROM brands
		WHERE workspace_id=$1 AND help_center_enabled ORDER BY is_default DESC, lower(name), id`, wid)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (PortalBrand, error) {
		var b PortalBrand
		return b, r.Scan(&b.ID, &b.Name, &b.Slug, &b.AuthMode, &b.Default)
	})
}

// invite creates a one-time password link for the contact and queues the invitation email
// in tx. It answers why nothing was sent ("" when it was), or an error.
func (s *service) invite(ctx context.Context, tx pgx.Tx, p *auth.Principal, brand PortalBrand, cid uuid.UUID) (string, error) {
	var email *string
	var blocked bool
	err := tx.QueryRow(ctx, `SELECT email, blocked FROM contacts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, p.WorkspaceID, cid).Scan(&email, &blocked)
	if db.IsNotFound(err) {
		return skipNotFound, nil
	}
	if err != nil {
		return "", err
	}
	switch {
	case email == nil || *email == "":
		return skipNoEmail, nil
	case blocked:
		return skipBlocked, nil
	}
	var recent int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM customer_password_resets WHERE workspace_id=$1 AND contact_id=$2 AND created_at>now()-interval '1 hour'`,
		p.WorkspaceID, cid).Scan(&recent); err != nil {
		return "", err
	}
	if recent >= linksPerContactHour {
		return skipRateLimited, nil
	}
	sender := p.UserID
	if sender == uuid.Nil {
		sender = p.APIKeyID
	}
	if !s.d.Limiter.Shared(ctx, "portal-invite:"+sender.String(), invitesPerMemberHour, time.Hour) {
		return skipSenderLimited, nil
	}
	if !s.d.Limiter.Shared(ctx, "portal-invite:ws:"+p.WorkspaceID.String(), invitesPerWorkspaceHour, time.Hour) {
		return skipWorkspaceLimited, nil
	}
	hc, err := kb.HelpCenterBySlug(ctx, tx, brand.Slug)
	if err != nil {
		return "", err
	}
	token := crypto.RandomToken(32)
	if _, err := tx.Exec(ctx, `INSERT INTO customer_password_resets(id,workspace_id,contact_id,email,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
		ids.New(), p.WorkspaceID, cid, *email, crypto.HashToken(token), time.Now().Add(inviteDays*24*time.Hour)); err != nil {
		return "", err
	}
	site := emails.SiteFrom(s.d.Cfg)
	link := site.App("/portal/"+url.PathEscape(brand.Slug)+"/reset") + "#token=" + url.QueryEscape(token)
	if err := enqueueMail(ctx, s.d, tx, *email, emails.CustomerPortalInvite(site, hc.Title, link, inviteDays)); err != nil {
		return "", err
	}
	// Who invited whom, from which brand; never the link.
	return "", audit.Log(ctx, tx, p, p.WorkspaceID, "contact.portal_invited", "contact", &cid, map[string]any{"brand_id": brand.ID})
}

// portalAccess reads the contact's portal access from its password, provider sign-ins,
// open links (ones the contact can still use: same email, not blocked) and sessions.
func (s *service) portalAccess(ctx context.Context, q db.Querier, wid, cid uuid.UUID) (PortalAccess, error) {
	var out PortalAccess
	var found bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM contacts WHERE workspace_id=$1 AND id=$2),
		EXISTS (SELECT 1 FROM customer_credentials WHERE workspace_id=$1 AND contact_id=$2),
		EXISTS (SELECT 1 FROM customer_oidc_identities WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL),
		(SELECT max(r.created_at) FROM customer_password_resets r JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id
			AND c.email=r.email AND NOT c.blocked WHERE r.workspace_id=$1 AND r.contact_id=$2 AND r.used_at IS NULL AND r.expires_at>now()),
		(SELECT max(r.expires_at) FROM customer_password_resets r JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id
			AND c.email=r.email AND NOT c.blocked WHERE r.workspace_id=$1 AND r.contact_id=$2 AND r.used_at IS NULL AND r.expires_at>now()),
		(SELECT max(created_at) FROM customer_sessions WHERE workspace_id=$1 AND contact_id=$2)`, wid, cid).
		Scan(&found, &out.Password, &out.SSO, &out.InvitedAt, &out.InviteExpiresAt, &out.LastSignInAt)
	if err != nil {
		return out, err
	}
	if !found {
		return out, httpx.NotFound("Contact")
	}
	switch {
	case out.Password || out.SSO:
		out.Status = accessActive
	case out.InvitedAt != nil:
		out.Status = accessInvited
	default:
		out.Status = accessNone
	}
	if out.Brands, err = portalBrands(ctx, q, wid); err != nil {
		return out, err
	}
	return out, nil
}
