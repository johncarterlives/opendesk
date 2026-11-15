package customerportal

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"

	"github.com/useopendesk/opendesk/internal/audit"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/netsafe"
	"github.com/useopendesk/opendesk/internal/products"
)

// ssoFlow marks the oauth_state tokens minted for a portal sign-in (the app's own sign-in and
// mailbox connections use the same purpose with other flows).
const ssoFlow = "customer_portal"

// ssoBindCookie ties a callback to the browser that started the sign-in.
const ssoBindCookie = "od_customer_sso"

// oidcClient is the guarded client for a brand's provider: public addresses only, no
// redirects. A test replaces it to reach a local provider.
var oidcClient = func() *http.Client { return netsafe.Client(false, 10*time.Second) }

// ssoBrand is the sign-in configuration of one brand.
type ssoBrand struct {
	Mode           string
	Protocol       string // oidc | saml
	Issuer         string
	ClientID       string
	Secret         []byte
	CreateContacts bool
	SAML           samlBrand
}

// identityIssuer is the issuer a link of this brand's provider is keyed by. SAML entity ids
// are kept apart from OIDC issuers, so one string cannot name both kinds of provider.
func (b ssoBrand) identityIssuer() string {
	if b.Protocol == "saml" {
		return "saml:" + b.SAML.EntityID
	}
	return b.Issuer
}

func (s *service) registerSSO(r chi.Router) {
	r.Get("/v1/public/help/{workspace_slug}/portal/sso/start", s.ssoStart)
	r.Get("/v1/public/help/{workspace_slug}/portal/sso/callback", s.ssoCallback)
	s.registerSAML(r)
}

func (s *service) ssoBindHash(v string) string {
	sum := sha256.Sum256([]byte("customer-sso-bind:" + v))
	return hex.EncodeToString(sum[:])
}

func (s *service) ssoBindCookie(slug, value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: ssoBindCookie, Value: value, Path: "/v1/public/help/" + url.PathEscape(slug) + "/portal/sso",
		HttpOnly: true, Secure: s.secureCookie(), SameSite: http.SameSiteLaxMode, MaxAge: maxAge}
}

func (s *service) ssoRedirectURL(slug string) string {
	return s.d.Cfg.APIURL + "/v1/public/help/" + url.PathEscape(slug) + "/portal/sso/callback"
}

// ssoReturnPath keeps the page a customer returns to inside the brand's own portal.
func ssoReturnPath(slug, raw string) string {
	home := "/portal/" + url.PathEscape(slug)
	if raw == "" || len(raw) > 1000 || strings.ContainsAny(raw, "\\\r\n\t") {
		return home
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return home
	}
	if (u.Path != home && !strings.HasPrefix(u.Path, home+"/")) || strings.Contains(u.Path, "..") {
		return home
	}
	return u.RequestURI()
}

// ssoDone sends the browser back to the portal, with the failure's code when there is one.
func (s *service) ssoDone(w http.ResponseWriter, r *http.Request, slug, back, code string, cookies ...*http.Cookie) {
	for _, c := range cookies {
		http.SetCookie(w, c)
	}
	w.Header().Set("Cache-Control", "no-store")
	target := s.d.Cfg.AppURL + ssoReturnPath(slug, back)
	if code != "" {
		target = s.d.Cfg.AppURL + "/portal/" + url.PathEscape(slug) + "?" + url.Values{"sso_error": {code}}.Encode()
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// ssoBrandFor loads the brand a sign-in is for. It answers "" when the brand takes no provider sign-in.
func (s *service) ssoBrandFor(ctx context.Context, hc kb.HelpCenter) (ssoBrand, string) {
	var b ssoBrand
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT portal_auth_mode, portal_sso_protocol, portal_oidc_issuer, portal_oidc_client_id,
        portal_oidc_client_secret_enc, portal_oidc_create_contacts, portal_saml_idp_entity_id, portal_saml_idp_sso_url,
        portal_saml_idp_certificates, portal_saml_email_attribute, portal_saml_name_attribute FROM brands WHERE workspace_id=$1 AND id=$2`,
		hc.WorkspaceID, hc.BrandID).Scan(&b.Mode, &b.Protocol, &b.Issuer, &b.ClientID, &b.Secret, &b.CreateContacts,
		&b.SAML.EntityID, &b.SAML.SSOURL, &b.SAML.Certificates, &b.SAML.EmailAttribute, &b.SAML.NameAttribute)
	if err != nil {
		return b, "server_error"
	}
	if b.Mode == "local" {
		return b, "sso_unavailable"
	}
	if b.Protocol == "saml" {
		if b.SAML.EntityID == "" || b.SAML.SSOURL == "" || b.SAML.Certificates == "" {
			return b, "sso_unavailable"
		}
		return b, ""
	}
	if b.Issuer == "" || len(b.Secret) == 0 {
		return b, "sso_unavailable"
	}
	return b, ""
}

func (s *service) ssoProvider(ctx context.Context, b ssoBrand, secret string) (*oidc.Provider, oauth2.Config, error) {
	prov, err := oidc.NewProvider(oidc.ClientContext(ctx, oidcClient()), b.Issuer)
	if err != nil {
		return nil, oauth2.Config{}, err
	}
	return prov, oauth2.Config{ClientID: b.ClientID, ClientSecret: secret, Endpoint: prov.Endpoint(),
		Scopes: []string{oidc.ScopeOpenID, "email", "profile"}}, nil
}

func (s *service) ssoStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "workspace_slug")))
	ip := httpx.ClientIP(s.d.Cfg.TrustProxy, s.d.Cfg.ProxyHops)(r)
	if !s.d.Limiter.Allow("customer-sso:start:"+ip, 30, 15*time.Minute) {
		s.ssoDone(w, r, slug, "", "rate_limited")
		return
	}
	hc, err := helpCenter(ctx, s.d, slug)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if products.RequireTickets(ctx, s.d.DB.Pool, hc.WorkspaceID) != nil {
		http.NotFound(w, r)
		return
	}
	b, code := s.ssoBrandFor(ctx, hc)
	if code != "" {
		s.ssoDone(w, r, hc.Slug, "", code)
		return
	}
	if b.Protocol == "saml" {
		s.samlStart(w, r, hc, b)
		return
	}
	secret, err := s.d.Box.Open(b.Secret)
	if err != nil {
		s.d.Log.Error("portal sso secret", "brand", hc.BrandID)
		s.ssoDone(w, r, hc.Slug, "", "server_error")
		return
	}
	_, cfg, err := s.ssoProvider(ctx, b, string(secret))
	if err != nil {
		s.d.Log.Warn("portal sso provider unavailable", "brand", hc.BrandID)
		s.ssoDone(w, r, hc.Slug, "", "provider_unavailable")
		return
	}
	cfg.RedirectURL = s.ssoRedirectURL(hc.Slug)
	verifier := oauth2.GenerateVerifier()
	sealed, err := s.d.Box.Seal([]byte(verifier))
	if err != nil {
		s.ssoDone(w, r, hc.Slug, "", "server_error")
		return
	}
	nonce, bind := crypto.RandomToken(16), crypto.RandomToken(16)
	state, _, err := s.d.Tokens.Sign(auth.Claims{Purpose: auth.PurposeOAuthState, Data: map[string]string{
		"flow": ssoFlow, "brand": hc.BrandID.String(), "v": base64.RawURLEncoding.EncodeToString(sealed),
		"nonce": nonce, "bind": s.ssoBindHash(bind), "rt": ssoReturnPath(hc.Slug, r.URL.Query().Get("redirect_to")),
	}}, "", auth.OAuthStateTTL)
	if err != nil {
		s.ssoDone(w, r, hc.Slug, "", "server_error")
		return
	}
	http.SetCookie(w, s.ssoBindCookie(hc.Slug, bind, int(auth.OAuthStateTTL.Seconds())))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("nonce", nonce)), http.StatusFound)
}

// ssoIdentity is what the provider vouched for.
type ssoIdentity struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
}

func (s *service) ssoCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "workspace_slug")))
	clear := s.ssoBindCookie(slug, "", -1)
	hc, err := helpCenter(ctx, s.d, slug)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ri := requestInfo{IP: httpx.ClientIP(s.d.Cfg.TrustProxy, s.d.Cfg.ProxyHops)(r), UserAgent: r.UserAgent()}
	if len(ri.UserAgent) > 400 {
		ri.UserAgent = ri.UserAgent[:400]
	}
	fail := func(code string, contact uuid.UUID) {
		s.ssoFailed(ctx, hc, contact, ri, code)
		s.ssoDone(w, r, hc.Slug, "", code, clear)
	}
	// A limited callback writes nothing, so the audit log grows no faster than the limit.
	if !s.d.Limiter.Allow("customer-sso:callback:"+ri.IP, 60, 15*time.Minute) {
		s.ssoDone(w, r, hc.Slug, "", "rate_limited", clear)
		return
	}
	if products.RequireTickets(ctx, s.d.DB.Pool, hc.WorkspaceID) != nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	st, err := s.d.Tokens.Verify(q.Get("state"), auth.PurposeOAuthState)
	if err != nil || st.Data["flow"] != ssoFlow || st.Data["brand"] != hc.BrandID.String() {
		fail("invalid_state", uuid.Nil)
		return
	}
	bc, err := r.Cookie(ssoBindCookie)
	if err != nil || subtle.ConstantTimeCompare([]byte(s.ssoBindHash(bc.Value)), []byte(st.Data["bind"])) != 1 {
		fail("invalid_state", uuid.Nil)
		return
	}
	if q.Get("error") != "" {
		fail("access_denied", uuid.Nil)
		return
	}
	code := q.Get("code")
	if code == "" || len(code) > 4096 {
		fail("invalid_request", uuid.Nil)
		return
	}
	b, bcode := s.ssoBrandFor(ctx, hc)
	if bcode != "" {
		fail(bcode, uuid.Nil)
		return
	}
	if b.Protocol != "oidc" {
		fail("sso_unavailable", uuid.Nil)
		return
	}
	id, err := s.ssoExchange(ctx, hc, b, st.Data, code)
	if err != nil {
		s.d.Log.Warn("portal sso sign-in refused", "brand", hc.BrandID)
		fail("provider_error", uuid.Nil)
		return
	}
	refresh, errCode, contact := s.ssoSignIn(ctx, hc, b, id, ri)
	if errCode != "" {
		fail(errCode, contact)
		return
	}
	s.ssoDone(w, r, hc.Slug, st.Data["rt"], "", clear, s.sessionCookie(refresh))
}

// ssoExchange trades the code for an ID token and verifies it: signature, issuer,
// audience, expiry and the nonce this browser's sign-in started with.
func (s *service) ssoExchange(ctx context.Context, hc kb.HelpCenter, b ssoBrand, state map[string]string, code string) (ssoIdentity, error) {
	var out ssoIdentity
	sealed, err := base64.RawURLEncoding.DecodeString(state["v"])
	if err != nil {
		return out, err
	}
	verifier, err := s.d.Box.Open(sealed)
	if err != nil {
		return out, err
	}
	secret, err := s.d.Box.Open(b.Secret)
	if err != nil {
		return out, err
	}
	prov, cfg, err := s.ssoProvider(ctx, b, string(secret))
	if err != nil {
		return out, err
	}
	cfg.RedirectURL = s.ssoRedirectURL(hc.Slug)
	ctx = oidc.ClientContext(ctx, oidcClient())
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(string(verifier)))
	if err != nil {
		return out, err
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return out, errors.New("no id token")
	}
	idt, err := prov.Verifier(&oidc.Config{ClientID: b.ClientID}).Verify(ctx, raw)
	if err != nil {
		return out, err
	}
	var c struct {
		Email         string `json:"email"`
		EmailVerified any    `json:"email_verified"`
		Name          string `json:"name"`
		Nonce         string `json:"nonce"`
	}
	if err := idt.Claims(&c); err != nil {
		return out, err
	}
	if state["nonce"] == "" || subtle.ConstantTimeCompare([]byte(c.Nonce), []byte(state["nonce"])) != 1 || idt.Subject == "" {
		return out, errors.New("nonce or subject")
	}
	verified := false
	switch v := c.EmailVerified.(type) {
	case bool:
		verified = v
	case string:
		verified = v == "true"
	}
	return ssoIdentity{Subject: idt.Subject, Email: normalizeEmail(c.Email), EmailVerified: verified, Name: c.Name}, nil
}

func (s *service) sessionCookie(refresh string) *http.Cookie {
	c := (&http.Cookie{Name: s.cookieName(), Value: refresh, Path: "/", HttpOnly: true, Secure: s.secureCookie(),
		SameSite: http.SameSiteLaxMode, MaxAge: int(auth.RefreshTTL.Seconds())})
	return c
}

// ssoFailed records a refused sign-in without the provider's claims.
func (s *service) ssoFailed(ctx context.Context, hc kb.HelpCenter, contact uuid.UUID, ri requestInfo, code string) {
	var entity *uuid.UUID
	if contact != uuid.Nil {
		entity = &contact
	}
	p := &auth.Principal{Kind: auth.KindCustomer, WorkspaceID: hc.WorkspaceID, ContactID: contact, IP: ri.IP, UserAgent: ri.UserAgent}
	_ = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		return audit.Log(ctx, tx, p, hc.WorkspaceID, "customer.sso.login.failed", "contact", entity, map[string]any{"brand_id": hc.BrandID, "reason": code})
	})
}

// ssoSignIn matches the identity to a contact and opens the session. It returns the
// session's refresh token, or the failure's code (and the contact it concerned, when known).
//
// Matching, in order: a live link of (issuer, subject) wins; a revoked one refuses; a first
// sign-in needs a verified address and finds the contact by it, linking a contact with no
// link yet and requiring an admin's relink authorization when the contact asks for one or
// is linked to another subject of the issuer; a contact that does not exist is created
// only when the brand allows it. A blocked contact never signs in.
func (s *service) ssoSignIn(ctx context.Context, hc kb.HelpCenter, b ssoBrand, id ssoIdentity, ri requestInfo) (string, string, uuid.UUID) {
	var refresh, errCode string
	var contact uuid.UUID
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		wid := hc.WorkspaceID
		var cid uuid.UUID
		var revoked *time.Time
		err := tx.QueryRow(ctx, `SELECT contact_id, revoked_at FROM customer_oidc_identities
            WHERE workspace_id=$1 AND issuer=$2 AND subject=$3 FOR UPDATE`, wid, b.identityIssuer(), id.Subject).Scan(&cid, &revoked)
		known := err == nil
		if err != nil && !db.IsNotFound(err) {
			return err
		}
		if known && revoked != nil {
			contact, errCode = cid, "identity_revoked"
			return nil
		}
		if !known {
			if id.Email == "" || !id.EmailVerified {
				errCode = "email_unverified"
				return nil
			}
			err := tx.QueryRow(ctx, `SELECT id FROM contacts WHERE workspace_id=$1 AND email=$2`, wid, id.Email).Scan(&cid)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if db.IsNotFound(err) {
				if !b.CreateContacts {
					errCode = "unknown_customer"
					return nil
				}
				name := displayname.CleanOr(id.Name, displayname.Person, displayname.FromEmail(id.Email))
				if cid, _, err = domain.UpsertContactByEmail(ctx, tx, wid, id.Email, name); err != nil {
					return err
				}
			}
		}
		// The contact's row serializes this with an email change, a block and a relink.
		var blocked, relink bool
		var email string
		if err := tx.QueryRow(ctx, `SELECT blocked, customer_oidc_relink_required, email FROM contacts
            WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, wid, cid).Scan(&blocked, &relink, &email); err != nil {
			return err
		}
		contact = cid
		if blocked {
			errCode = "blocked"
			return nil
		}
		p := &auth.Principal{Kind: auth.KindCustomer, WorkspaceID: wid, ContactID: cid, IP: ri.IP, UserAgent: ri.UserAgent}
		if !known {
			var other bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM customer_oidc_identities
                WHERE workspace_id=$1 AND contact_id=$2 AND issuer=$3 AND revoked_at IS NULL)`, wid, cid, b.identityIssuer()).Scan(&other); err != nil {
				return err
			}
			if relink || other {
				tag, err := tx.Exec(ctx, `UPDATE customer_oidc_relink_authorizations SET used_at=now()
                    WHERE workspace_id=$1 AND brand_id=$2 AND contact_id=$3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()`,
					wid, hc.BrandID, cid)
				if err != nil {
					return err
				}
				if tag.RowsAffected() != 1 {
					errCode = "relink_required"
					return nil
				}
				if _, err := tx.Exec(ctx, `UPDATE customer_oidc_identities SET revoked_at=now(), updated_at=now()
                    WHERE workspace_id=$1 AND contact_id=$2 AND issuer=$3 AND revoked_at IS NULL`, wid, cid, b.identityIssuer()); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO customer_oidc_identities(id,workspace_id,brand_id,contact_id,issuer,subject,email)
                VALUES($1,$2,$3,$4,$5,$6,$7)`, ids.New(), wid, hc.BrandID, cid, b.identityIssuer(), id.Subject, email); err != nil {
				return err
			}
			if relink {
				if _, err := tx.Exec(ctx, `UPDATE contacts SET customer_oidc_relink_required=false WHERE workspace_id=$1 AND id=$2`, wid, cid); err != nil {
					return err
				}
			}
			if err := audit.Log(ctx, tx, p, wid, "customer.sso.linked", "contact", &cid, map[string]any{"brand_id": hc.BrandID}); err != nil {
				return err
			}
		}
		var active bool
		if err := tx.QueryRow(ctx, `SELECT suspended_at IS NULL FROM workspaces WHERE id=$1`, wid).Scan(&active); err != nil {
			return err
		}
		if !active {
			errCode = "sso_unavailable"
			return nil
		}
		sid := ids.New()
		refresh = crypto.RandomToken(32)
		if _, err := tx.Exec(ctx, `INSERT INTO customer_sessions(id,workspace_id,contact_id,email,refresh_hash,ip,user_agent,expires_at,method)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, sid, wid, cid, email, crypto.HashToken(refresh), ri.IP, ri.UserAgent, time.Now().Add(auth.RefreshTTL), b.Protocol); err != nil {
			return err
		}
		return audit.Log(ctx, tx, p, wid, "customer.sso.login", "contact", &cid, map[string]any{"brand_id": hc.BrandID})
	})
	if err != nil {
		s.d.Log.Error("portal sso sign-in", "brand", hc.BrandID, "err", err)
		return "", "server_error", uuid.Nil
	}
	if errCode != "" {
		return "", errCode, contact
	}
	return refresh, "", contact
}
