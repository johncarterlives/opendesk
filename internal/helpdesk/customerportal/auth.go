package customerportal

import (
	"context"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/captcha"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/emails"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
	"github.com/useopendesk/opendesk/internal/mailer"
)

const resetTTL = time.Hour

type service struct{ d *deps.Deps }
type requestKey struct{}
type requestInfo struct{ IP, UserAgent, Refresh string }

type loginBody struct {
	Email          string `json:"email" maxLength:"320"`
	Password       string `json:"password" maxLength:"1024"`
	TurnstileToken string `json:"turnstile_token,omitempty" maxLength:"4096"`
}
type authResult struct {
	AccessToken    string    `json:"access_token"`
	ExpiresAt      time.Time `json:"expires_at"`
	ChangePassword bool      `json:"change_password,omitempty" doc:"Ask the customer to choose a password that meets the current policy"`
}
type authOut struct {
	SetCookie string `header:"Set-Cookie"`
	Body      authResult
}

func (s *service) operation(id, method, path, summary string, public bool) huma.Operation {
	op := huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Tags: []string{"Customer portal"}, Middlewares: huma.Middlewares{s.withRequest}}
	if public {
		op.Security = []map[string][]string{}
	}
	return op
}
func (s *service) withRequest(ctx huma.Context, next func(huma.Context)) {
	ctx.SetHeader("Cache-Control", "no-store")
	ri := requestInfo{}
	if r, _ := humachi.Unwrap(ctx); r != nil {
		ri.IP = httpx.ClientIP(s.d.Cfg.TrustProxy, s.d.Cfg.ProxyHops)(r)
		ri.UserAgent = r.UserAgent()
		if len(ri.UserAgent) > 400 {
			ri.UserAgent = ri.UserAgent[:400]
		}
		origin := r.Header.Get("Origin")
		if origin == "" || origin == s.d.Cfg.AppURL {
			if c, err := r.Cookie(s.cookieName()); err == nil {
				ri.Refresh = c.Value
			}
		}
	}
	next(huma.WithValue(ctx, requestKey{}, ri))
}
func info(ctx context.Context) requestInfo {
	ri, _ := ctx.Value(requestKey{}).(requestInfo)
	return ri
}
func (s *service) secureCookie() bool {
	return s.d.Cfg.CookieSecure || strings.HasPrefix(s.d.Cfg.APIURL, "https://")
}
func (s *service) cookieName() string {
	if s.secureCookie() {
		return "__Host-od_customer_refresh"
	}
	return "od_customer_refresh"
}
func (s *service) cookie(value string, maxAge int) string {
	return (&http.Cookie{Name: s.cookieName(), Value: value, Path: "/", HttpOnly: true, Secure: s.secureCookie(), SameSite: http.SameSiteLaxMode, MaxAge: maxAge}).String()
}
func (s *service) limit(ctx context.Context, key string, count int, period time.Duration) error {
	if !s.d.Limiter.Shared(ctx, "customer-portal:"+key, count, period) {
		return httpx.RateLimited()
	}
	return nil
}
func (s *service) human(ctx context.Context, token string) error {
	if s.d.Captcha == nil {
		return captcha.ErrCaptcha
	}
	u, err := url.Parse(s.d.Cfg.AppURL)
	if err != nil || u.Hostname() == "" {
		return captcha.ErrCaptcha
	}
	return s.d.Captcha.VerifyHostname(ctx, token, info(ctx).IP, u.Hostname())
}
func normalizeEmail(value string) string {
	value = strings.TrimSpace(value)
	a, err := mail.ParseAddress(value)
	if err != nil || a.Address != value || len(value) > 254 || !strings.Contains(value, "@") {
		return ""
	}
	return strings.ToLower(value)
}
func invalidCredentials() error {
	return httpx.E(401, "invalid_credentials", "The email or password is incorrect.")
}
func invalidToken() error {
	return httpx.E(400, "invalid_token", "This link is invalid or has expired.")
}

func (s *service) registerAuth(api huma.API) {
	prefix := "/v1/public/help/{workspace_slug}/portal/auth/"
	huma.Register(api, s.operation("customer-portal-login", "POST", prefix+"login", "Sign in to the customer portal", true),
		func(ctx context.Context, in *struct {
			Slug string `path:"workspace_slug"`
			Body loginBody
		}) (*authOut, error) {
			out, err := s.login(ctx, in.Slug, in.Body)
			return out, httpx.Wrap(err)
		})
	forgot := s.operation("customer-portal-forgot", "POST", prefix+"forgot", "Email a customer password link", true)
	forgot.DefaultStatus = http.StatusNoContent
	huma.Register(api, forgot, func(ctx context.Context, in *struct {
		Slug string `path:"workspace_slug"`
		Body struct {
			Email          string `json:"email" maxLength:"320"`
			TurnstileToken string `json:"turnstile_token,omitempty" maxLength:"4096"`
		}
	}) (*struct{}, error) {
		if err := s.limit(ctx, "forgot:ip:"+info(ctx).IP, 10, time.Hour); err != nil {
			return nil, err
		}
		if err := s.human(ctx, in.Body.TurnstileToken); err != nil {
			return nil, httpx.Wrap(err)
		}
		hc, err := helpCenter(ctx, s.d, in.Slug)
		if err != nil {
			return nil, err
		}
		email := normalizeEmail(in.Body.Email)
		if email == "" || s.limit(ctx, "forgot:email:"+hc.WorkspaceID.String()+":"+email, 3, time.Hour) != nil {
			return nil, nil
		}
		_, err = s.d.Jobs.Insert(ctx, jobs.CustomerPortalForgotArgs{WorkspaceID: hc.WorkspaceID, Slug: hc.Slug, Email: email}, &river.InsertOpts{Queue: jobs.QueueEmail, MaxAttempts: 5})
		return nil, httpx.Wrap(err)
	})
	reset := s.operation("customer-portal-reset", "POST", prefix+"reset", "Choose a customer portal password", true)
	reset.DefaultStatus = http.StatusNoContent
	huma.Register(api, reset, func(ctx context.Context, in *struct {
		Slug string `path:"workspace_slug"`
		Body struct {
			Token          string `json:"token" maxLength:"200"`
			Password       string `json:"password" maxLength:"1024"`
			TurnstileToken string `json:"turnstile_token,omitempty" maxLength:"4096"`
		}
	}) (*struct{}, error) {
		return nil, httpx.Wrap(s.reset(ctx, in.Slug, in.Body.Token, in.Body.Password, in.Body.TurnstileToken))
	})
	huma.Register(api, s.operation("customer-portal-refresh", "POST", "/v1/customer/portal/auth/refresh", "Refresh a customer session", true),
		func(ctx context.Context, in *struct {
			Body struct {
				Slug string `json:"workspace_slug" minLength:"1" maxLength:"40"`
			}
		}) (*authOut, error) {
			out, err := s.refresh(ctx, in.Body.Slug)
			return out, httpx.Wrap(err)
		})
	logout := s.operation("customer-portal-logout", "POST", "/v1/customer/portal/auth/logout", "Sign out of the customer portal", false)
	logout.DefaultStatus = http.StatusNoContent
	huma.Register(api, logout, func(ctx context.Context, _ *struct{}) (*struct {
		SetCookie string `header:"Set-Cookie"`
	}, error) {
		p, err := auth.RequireCustomer(ctx)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE customer_sessions SET revoked_at = now()
                WHERE workspace_id = $1 AND contact_id = $2 AND id = $3`, p.WorkspaceID, p.ContactID, p.SessionID); err != nil {
				return err
			}
			return audit.Log(ctx, tx, p, p.WorkspaceID, "customer.logout", "contact", &p.ContactID, nil)
		})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct {
			SetCookie string `header:"Set-Cookie"`
		}{s.cookie("", -1)}, nil
	})
}

func (s *service) login(ctx context.Context, slug string, in loginBody) (*authOut, error) {
	ri := info(ctx)
	if err := s.limit(ctx, "login:ip:"+ri.IP, 30, 15*time.Minute); err != nil {
		return nil, err
	}
	if err := s.human(ctx, in.TurnstileToken); err != nil {
		return nil, err
	}
	hc, err := helpCenter(ctx, s.d, slug)
	if err != nil {
		return nil, err
	}
	email := normalizeEmail(in.Email)
	if err := s.limit(ctx, "login:email:"+hc.WorkspaceID.String()+":"+email, 10, 15*time.Minute); err != nil {
		return nil, err
	}
	var out *authOut
	err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var cid uuid.UUID
		var hash *string
		var contactEmail string
		var blocked bool
		err := tx.QueryRow(ctx, `SELECT id,email,blocked FROM contacts
   WHERE workspace_id=$1 AND email=$2 FOR UPDATE`, hc.WorkspaceID, email).Scan(&cid, &contactEmail, &blocked)
		if err != nil && !db.IsNotFound(err) {
			return err
		}
		// Read the password after acquiring the identity lock, so a concurrent
		// password reset is reflected in this statement's fresh snapshot.
		if cid != uuid.Nil {
			err := tx.QueryRow(ctx, `SELECT password_hash FROM customer_credentials
   WHERE workspace_id=$1 AND contact_id=$2 AND email=$3`, hc.WorkspaceID, cid, contactEmail).Scan(&hash)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
		}
		valid := false
		if hash == nil {
			auth.DummyVerify(in.Password)
		} else {
			valid = auth.VerifyPassword(in.Password, *hash)
		}
		p := &auth.Principal{Kind: auth.KindCustomer, WorkspaceID: hc.WorkspaceID, ContactID: cid, IP: ri.IP, UserAgent: ri.UserAgent}
		var entity *uuid.UUID
		if cid != uuid.Nil {
			entity = &cid
		}
		if !valid || blocked {
			return audit.Log(ctx, tx, p, hc.WorkspaceID, "customer.login.failed", "contact", entity, nil)
		}
		// The workspace is checked again inside the write's transaction.
		var active bool
		if err := tx.QueryRow(ctx, `SELECT suspended_at IS NULL FROM workspaces WHERE id=$1`, hc.WorkspaceID).Scan(&active); err != nil {
			return err
		}
		if !active {
			return nil
		}
		if auth.CheckPassword(in.Password) != nil {
			// A weak legacy password may be verified, but it must not establish a
			// customer session. Revoke any existing session and clear its cookie so
			// the portal can require the password-link flow without relying on a
			// follow-up browser logout request.
			if _, err := tx.Exec(ctx, `UPDATE customer_sessions SET revoked_at=now()
   WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL`, hc.WorkspaceID, cid); err != nil {
				return err
			}
			out = &authOut{SetCookie: s.cookie("", -1), Body: authResult{ChangePassword: true}}
			return audit.Log(ctx, tx, p, hc.WorkspaceID, "customer.login.password_change_required", "contact", &cid, nil)
		}
		sid := ids.New()
		refresh := crypto.RandomToken(32)
		expires := time.Now().Add(auth.RefreshTTL)
		if _, err := tx.Exec(ctx, `INSERT INTO customer_sessions(id,workspace_id,contact_id,email,refresh_hash,ip,user_agent,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, sid, hc.WorkspaceID, cid, contactEmail, crypto.HashToken(refresh), ri.IP, ri.UserAgent, expires); err != nil {
			return err
		}
		var errOut error
		out, errOut = s.sessionOut(hc.WorkspaceID, cid, sid, refresh, expires)
		if errOut != nil {
			return errOut
		}
		return audit.Log(ctx, tx, p, hc.WorkspaceID, "customer.login", "contact", &cid, nil)
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, invalidCredentials()
	}
	return out, nil
}

func (s *service) sessionOut(wid, cid, sid uuid.UUID, refresh string, expires time.Time) (*authOut, error) {
	ttl := min(auth.AccessTTL, time.Until(expires))
	access, exp, err := s.d.Tokens.Sign(auth.Claims{Purpose: auth.PurposeCustomerAccess, SessionID: sid.String(), Workspace: wid.String()}, cid.String(), ttl)
	if err != nil {
		return nil, err
	}
	maxAge := max(1, int(time.Until(expires).Seconds()))
	return &authOut{SetCookie: s.cookie(refresh, maxAge), Body: authResult{AccessToken: access, ExpiresAt: exp}}, nil
}

func (s *service) refresh(ctx context.Context, slug string) (*authOut, error) {
	ri := info(ctx)
	if err := s.limit(ctx, "refresh:ip:"+ri.IP, 120, time.Minute); err != nil {
		return nil, err
	}
	if ri.Refresh == "" || len(ri.Refresh) > 200 {
		return nil, auth.ErrUnauthenticated
	}
	var out *authOut
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var sid, wid, cid uuid.UUID
		// Lock the contact before the session, as login and password reset do.
		// This also serializes refresh with contact lifecycle invalidation.
		var email string
		if err := tx.QueryRow(ctx, `SELECT c.email FROM customer_sessions s JOIN contacts c ON c.workspace_id=s.workspace_id AND c.id=s.contact_id
   WHERE s.refresh_hash=$1 FOR UPDATE OF c`, crypto.HashToken(ri.Refresh)).Scan(&email); err != nil {
			return err
		}
		var expires time.Time
		// The slug constrains the portal being opened; identity still comes from
		// the live session and can never be selected by the caller's input.
		err := tx.QueryRow(ctx, `SELECT s.id,s.workspace_id,s.contact_id,s.expires_at FROM customer_sessions s
   JOIN contacts c ON c.workspace_id=s.workspace_id AND c.id=s.contact_id
   JOIN customer_credentials a ON a.workspace_id=s.workspace_id AND a.contact_id=s.contact_id
   JOIN workspaces w ON w.id=s.workspace_id
   JOIN brands b ON b.workspace_id=s.workspace_id AND b.slug=$2 AND b.help_center_enabled
   WHERE s.refresh_hash=$1 AND `+auth.CustomerSessionLive+` FOR UPDATE OF s`, crypto.HashToken(ri.Refresh), strings.ToLower(strings.TrimSpace(slug))).Scan(&sid, &wid, &cid, &expires)
		if err != nil {
			return err
		}
		token := crypto.RandomToken(32)
		if _, err := tx.Exec(ctx, `UPDATE customer_sessions SET refresh_hash=$2 WHERE id=$1`, sid, crypto.HashToken(token)); err != nil {
			return err
		}
		out, err = s.sessionOut(wid, cid, sid, token, expires)
		return err
	})
	if db.IsNotFound(err) {
		return nil, auth.ErrUnauthenticated
	}
	return out, err
}

func (s *service) reset(ctx context.Context, slug, token, password, challenge string) error {
	if err := s.limit(ctx, "reset:ip:"+info(ctx).IP, 20, time.Hour); err != nil {
		return err
	}
	if err := s.human(ctx, challenge); err != nil {
		return err
	}
	hc, err := helpCenter(ctx, s.d, slug)
	if err != nil {
		return err
	}
	if err := auth.CheckPassword(password); err != nil {
		return err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	if token == "" {
		return invalidToken()
	}
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var cid uuid.UUID
		var email string
		// Lock the identity first so separate reset links cannot race one another.
		err := tx.QueryRow(ctx, `SELECT c.id,c.email FROM customer_password_resets r
   JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id AND c.email=r.email AND NOT c.blocked
   JOIN workspaces w ON w.id=r.workspace_id AND w.suspended_at IS NULL
   WHERE r.workspace_id=$1 AND r.token_hash=$2 AND r.used_at IS NULL AND r.expires_at>now() FOR UPDATE OF c`, hc.WorkspaceID, crypto.HashToken(token)).Scan(&cid, &email)
		if db.IsNotFound(err) {
			return invalidToken()
		}
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE customer_password_resets SET used_at=now() WHERE workspace_id=$1 AND contact_id=$2 AND token_hash=$3 AND used_at IS NULL AND expires_at>now()`, hc.WorkspaceID, cid, crypto.HashToken(token))
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return invalidToken()
		}
		if _, err := tx.Exec(ctx, `INSERT INTO customer_credentials(workspace_id,contact_id,email,password_hash) VALUES($1,$2,$3,$4)
   ON CONFLICT(workspace_id,contact_id) DO UPDATE SET email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,updated_at=now()`, hc.WorkspaceID, cid, email, hash); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE customer_sessions SET revoked_at=now() WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL`, hc.WorkspaceID, cid); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE customer_password_resets SET used_at=now() WHERE workspace_id=$1 AND contact_id=$2 AND used_at IS NULL`, hc.WorkspaceID, cid); err != nil {
			return err
		}
		p := &auth.Principal{Kind: auth.KindCustomer, WorkspaceID: hc.WorkspaceID, ContactID: cid, IP: info(ctx).IP}
		if err := audit.Log(ctx, tx, p, hc.WorkspaceID, "customer.password.reset", "contact", &cid, nil); err != nil {
			return err
		}
		link := emails.SiteFrom(s.d.Cfg).App("/portal/" + url.PathEscape(hc.Slug))
		return enqueueMail(ctx, s.d, tx, email, emails.CustomerPortalPasswordChanged(emails.SiteFrom(s.d.Cfg), hc.Title, link))
	})
}

func enqueueMail(ctx context.Context, d *deps.Deps, tx pgx.Tx, to string, m mailer.Mail) error {
	_, err := d.Jobs.InsertTx(ctx, tx, jobs.SystemEmailArgs{To: to, Subject: m.Subject, HTML: m.HTML, Text: m.Text, Headers: m.Headers}, &river.InsertOpts{Queue: jobs.QueueEmail, MaxAttempts: 8})
	return err
}
