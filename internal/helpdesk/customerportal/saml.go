package customerportal

import (
	"context"
	"crypto/subtle"
	"encoding/xml"
	"net/http"
	"net/url"
	"strings"
	"time"

	saml2 "github.com/russellhaering/gosaml2"
	dsig "github.com/russellhaering/goxmldsig"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/helpdesk/samlsp"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/products"
)

// SAML 2.0 sign-in (contracts/customer-portal.md "SAML"): the service provider asks the brand's
// identity provider for an assertion (Web SSO, HTTP-Redirect request, HTTP-POST response) and
// signs the customer in from it with the same matching, links and sessions as an OIDC
// sign-in. The provider is trusted only through its signing certificates and entity id; the
// customer starts at the portal, never at the provider (no IdP-initiated sign-in).

// samlFlow marks the state minted for a SAML sign-in.
const samlFlow = "customer_portal_saml"

// samlMaxResponse bounds the form a provider posts.
const samlMaxResponse = 1 << 20

// samlClockSkew is how far ahead of ours a provider's clock may run: providers set NotBefore to
// the instant they sign, so a slightly fast clock would otherwise refuse every fresh assertion.
// NotOnOrAfter, of the conditions and of the bearer confirmation, is held to our clock exactly.
const samlClockSkew = 2 * time.Minute

const (
	samlNameIDPersistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
	samlNameIDTransient  = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
)

// samlBrand is a brand's SAML provider.
type samlBrand struct {
	EntityID       string
	SSOURL         string
	Certificates   string
	EmailAttribute string
	NameAttribute  string
}

var samlEmailAttributes = []string{
	"email", "mail", "emailAddress", "Email", "EmailAddress",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
	"urn:oid:0.9.2342.19200300.100.1.3",
}

var samlNameAttributes = []string{
	"name", "displayName", "Name", "DisplayName",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
	"urn:oid:2.16.840.1.113730.3.1.241",
}

func (s *service) registerSAML(r chi.Router) {
	r.Post("/v1/public/help/{workspace_slug}/portal/sso/saml/acs", s.samlACS)
	r.Get("/v1/public/help/{workspace_slug}/portal/sso/saml/metadata", s.samlMetadata)
}

func (s *service) samlBase(slug string) string {
	return s.d.Cfg.APIURL + "/v1/public/help/" + url.PathEscape(slug) + "/portal/sso/saml"
}

// samlEntityID is the service provider's own id, its metadata URL.
func (s *service) samlEntityID(slug string) string { return s.samlBase(slug) + "/metadata" }
func (s *service) samlACSURL(slug string) string   { return s.samlBase(slug) + "/acs" }

// samlCookie carries the sign-in's state in the browser that started it. The provider's POST
// comes from another site, so on https it is sent cross-site (SameSite=None); a response
// without it was not asked for by this browser and is refused.
func (s *service) samlCookie(slug, value string, maxAge int) *http.Cookie {
	c := s.ssoBindCookie(slug, value, maxAge)
	c.Name = ssoBindCookie + "_saml"
	if c.Secure {
		c.SameSite = http.SameSiteNoneMode
	}
	return c
}

func (s *service) samlProvider(slug string, b ssoBrand) (*saml2.SAMLServiceProvider, error) {
	certs, err := samlsp.ParseCertificates(b.SAML.Certificates, time.Time{})
	if err != nil {
		return nil, err
	}
	store := &dsig.MemoryX509CertificateStore{}
	for _, c := range certs {
		store.Roots = append(store.Roots, c)
	}
	return &saml2.SAMLServiceProvider{
		IdentityProviderSSOURL:      b.SAML.SSOURL,
		IdentityProviderIssuer:      b.SAML.EntityID,
		ServiceProviderIssuer:       s.samlEntityID(slug),
		AudienceURI:                 s.samlEntityID(slug),
		AssertionConsumerServiceURL: s.samlACSURL(slug),
		IDPCertificateStore:         store,
		NameIdFormat:                samlNameIDPersistent,
		AllowMissingAttributes:      true,
		Clock:                       dsig.NewRealClock(),
	}, nil
}

// samlStart sends the customer to the provider with a signed-in-state of its own: a request
// id the assertion must answer, and a relay value only this browser holds.
func (s *service) samlStart(w http.ResponseWriter, r *http.Request, hc kb.HelpCenter, b ssoBrand) {
	sp, err := s.samlProvider(hc.Slug, b)
	if err != nil {
		s.d.Log.Warn("portal saml provider unusable", "brand", hc.BrandID)
		s.ssoDone(w, r, hc.Slug, "", "provider_unavailable")
		return
	}
	doc, err := sp.BuildAuthRequestDocumentNoSig()
	if err != nil || doc.Root() == nil {
		s.ssoDone(w, r, hc.Slug, "", "server_error")
		return
	}
	rid := doc.Root().SelectAttrValue("ID", "")
	relay := crypto.RandomToken(16)
	state, _, err := s.d.Tokens.Sign(auth.Claims{Purpose: auth.PurposeOAuthState, Data: map[string]string{
		"flow": samlFlow, "brand": hc.BrandID.String(), "rid": rid, "relay": relay,
		"rt": ssoReturnPath(hc.Slug, r.URL.Query().Get("redirect_to")),
	}}, "", auth.OAuthStateTTL)
	if err != nil || rid == "" {
		s.ssoDone(w, r, hc.Slug, "", "server_error")
		return
	}
	target, err := sp.BuildAuthURLRedirect(relay, doc)
	if err != nil {
		s.ssoDone(w, r, hc.Slug, "", "provider_unavailable")
		return
	}
	http.SetCookie(w, s.samlCookie(hc.Slug, state, int(auth.OAuthStateTTL.Seconds())))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target, http.StatusFound)
}

func firstValue(v saml2.Values, names []string) string {
	for _, n := range names {
		if x := strings.TrimSpace(v.Get(n)); x != "" {
			return x
		}
	}
	return ""
}

// samlACS takes the provider's POST: the response must answer this browser's request, be
// signed by a certificate the brand trusts, name this service provider, be current and be
// unused, before anyone is signed in.
func (s *service) samlACS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "workspace_slug")))
	clear := s.samlCookie(slug, "", -1)
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
	if !s.d.Limiter.Allow("customer-sso:callback:"+ri.IP, 60, 15*time.Minute) {
		s.ssoDone(w, r, hc.Slug, "", "rate_limited", clear)
		return
	}
	if products.RequireTickets(ctx, s.d.DB.Pool, hc.WorkspaceID) != nil {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, samlMaxResponse)
	if err := r.ParseForm(); err != nil {
		fail("invalid_request", uuid.Nil)
		return
	}
	cookie, err := r.Cookie(ssoBindCookie + "_saml")
	if err != nil {
		fail("invalid_state", uuid.Nil)
		return
	}
	st, err := s.d.Tokens.Verify(cookie.Value, auth.PurposeOAuthState)
	relay := r.PostForm.Get("RelayState")
	if err != nil || st.Data["flow"] != samlFlow || st.Data["brand"] != hc.BrandID.String() || st.Data["rid"] == "" ||
		subtle.ConstantTimeCompare([]byte(relay), []byte(st.Data["relay"])) != 1 {
		fail("invalid_state", uuid.Nil)
		return
	}
	raw := r.PostForm.Get("SAMLResponse")
	if raw == "" {
		fail("invalid_request", uuid.Nil)
		return
	}
	b, code := s.ssoBrandFor(ctx, hc)
	if code != "" {
		fail(code, uuid.Nil)
		return
	}
	if b.Protocol != "saml" {
		fail("sso_unavailable", uuid.Nil)
		return
	}
	id, code := s.samlIdentity(ctx, hc, b, raw, st.Data["rid"])
	if code != "" {
		fail(code, uuid.Nil)
		return
	}
	refresh, errCode, contact := s.ssoSignIn(ctx, hc, b, id, ri)
	if errCode != "" {
		fail(errCode, contact)
		return
	}
	s.ssoDone(w, r, hc.Slug, st.Data["rt"], "", clear, s.sessionCookie(refresh))
}

// samlIdentity validates the response and reads who it vouches for.
func (s *service) samlIdentity(ctx context.Context, hc kb.HelpCenter, b ssoBrand, raw, rid string) (ssoIdentity, string) {
	var out ssoIdentity
	sp, err := s.samlProvider(hc.Slug, b)
	if err != nil {
		return out, "provider_unavailable"
	}
	info, err := sp.RetrieveAssertionInfo(raw)
	if err != nil || info == nil || len(info.Assertions) == 0 {
		s.d.Log.Warn("portal saml response refused", "brand", hc.BrandID)
		return out, "provider_error"
	}
	// The library's time warning allows no clock skew; the conditions' times are judged below.
	if info.WarningInfo == nil || info.WarningInfo.NotInAudience {
		s.d.Log.Warn("portal saml assertion not for this service", "brand", hc.BrandID)
		return out, "provider_error"
	}
	a := info.Assertions[0]
	sub := a.Subject
	if sub == nil || sub.SubjectConfirmation == nil || sub.SubjectConfirmation.SubjectConfirmationData == nil ||
		sub.SubjectConfirmation.SubjectConfirmationData.InResponseTo != rid || a.ID == "" || a.Conditions == nil {
		return out, "provider_error"
	}
	// The library judges the restrictions an assertion has; one with none is meant for anyone,
	// so a captured assertion could be offered to any service provider that trusts the provider.
	if len(a.Conditions.AudienceRestrictions) == 0 {
		return out, "provider_error"
	}
	if info.NameID == "" || len(info.NameID) > 500 {
		return out, "provider_error"
	}
	// A transient NameID changes at every sign-in, so it cannot be the customer's link.
	if sub.NameID != nil && strings.TrimSpace(sub.NameID.Format) == samlNameIDTransient {
		s.d.Log.Warn("portal saml transient name id", "brand", hc.BrandID)
		return out, "transient_name_id"
	}
	notBefore, err := time.Parse(time.RFC3339, a.Conditions.NotBefore)
	if err != nil {
		return out, "provider_error"
	}
	until, err := time.Parse(time.RFC3339, a.Conditions.NotOnOrAfter)
	if err != nil {
		return out, "provider_error"
	}
	if now := time.Now(); now.Before(notBefore.Add(-samlClockSkew)) || !now.Before(until) {
		s.d.Log.Warn("portal saml assertion not current", "brand", hc.BrandID)
		return out, "provider_error"
	}
	// Each assertion signs one customer in once.
	var fresh bool
	err = s.d.DB.Pool.QueryRow(ctx, `WITH gone AS (DELETE FROM customer_saml_assertions WHERE expires_at < now()),
        ins AS (INSERT INTO customer_saml_assertions (workspace_id, assertion_id, expires_at) VALUES ($1,$2,$3)
        ON CONFLICT DO NOTHING RETURNING 1) SELECT EXISTS (SELECT 1 FROM ins)`,
		hc.WorkspaceID, a.ID, until.Add(samlClockSkew)).Scan(&fresh)
	if err != nil {
		s.d.Log.Error("portal saml replay record", "brand", hc.BrandID, "err", err)
		return out, "server_error"
	}
	if !fresh {
		return out, "invalid_state"
	}
	emailNames, nameNames := samlEmailAttributes, samlNameAttributes
	if b.SAML.EmailAttribute != "" {
		emailNames = []string{b.SAML.EmailAttribute}
	}
	if b.SAML.NameAttribute != "" {
		nameNames = []string{b.SAML.NameAttribute}
	}
	email := firstValue(info.Values, emailNames)
	if email == "" && b.SAML.EmailAttribute == "" && strings.Contains(info.NameID, "@") {
		email = info.NameID
	}
	// The provider is the authority for its customers' addresses: its signed assertion is the
	// verification an OIDC provider's email_verified claim stands for.
	return ssoIdentity{Subject: info.NameID, Email: normalizeEmail(email), EmailVerified: email != "", Name: firstValue(info.Values, nameNames)}, ""
}

type samlMetadataDoc struct {
	XMLName  xml.Name `xml:"urn:oasis:names:tc:SAML:2.0:metadata EntityDescriptor"`
	EntityID string   `xml:"entityID,attr"`
	SP       struct {
		ProtocolSupportEnumeration string   `xml:"protocolSupportEnumeration,attr"`
		AuthnRequestsSigned        string   `xml:"AuthnRequestsSigned,attr"`
		WantAssertionsSigned       string   `xml:"WantAssertionsSigned,attr"`
		NameIDFormat               []string `xml:"NameIDFormat"`
		ACS                        struct {
			Binding  string `xml:"Binding,attr"`
			Location string `xml:"Location,attr"`
			Index    int    `xml:"index,attr"`
			Default  string `xml:"isDefault,attr"`
		} `xml:"AssertionConsumerService"`
	} `xml:"SPSSODescriptor"`
}

// samlMetadata describes this brand's service provider for the person setting up the
// identity provider: its entity id and where assertions are posted. It holds nothing secret and
// needs no brand to be configured for SAML yet.
func (s *service) samlMetadata(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	slug := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "workspace_slug")))
	hc, err := helpCenter(ctx, s.d, slug)
	if err != nil || products.RequireTickets(ctx, s.d.DB.Pool, hc.WorkspaceID) != nil {
		http.NotFound(w, r)
		return
	}
	var d samlMetadataDoc
	d.EntityID = s.samlEntityID(hc.Slug)
	d.SP.ProtocolSupportEnumeration = "urn:oasis:names:tc:SAML:2.0:protocol"
	d.SP.AuthnRequestsSigned = "false"
	d.SP.WantAssertionsSigned = "true"
	d.SP.NameIDFormat = []string{"urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"}
	d.SP.ACS.Binding = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
	d.SP.ACS.Location = s.samlACSURL(hc.Slug)
	d.SP.ACS.Index = 0
	d.SP.ACS.Default = "true"
	out, err := xml.MarshalIndent(d, "", "  ")
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/samlmetadata+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(append([]byte(xml.Header), out...))
}
