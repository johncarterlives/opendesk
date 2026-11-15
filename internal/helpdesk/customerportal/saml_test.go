package customerportal

import (
	"bytes"
	"compress/flate"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/beevik/etree"
	dsig "github.com/russellhaering/goxmldsig"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
)

const samlSSOURL = "https://idp.example.test/sso"
const samlEntity = "https://idp.example.test/entity"

// samlIDP signs assertions the way an identity provider does.
type samlIDP struct {
	key  *rsa.PrivateKey
	cert []byte
	pem  string
}

func newSAMLIDP(t *testing.T) *samlIDP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "idp.example.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &samlIDP{key: key, cert: der, pem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

// useSAML points the brand at the provider.
func useSAML(t *testing.T, e *hdtest.Env, ws hdtest.WS, p *samlIDP, mode string, create bool) {
	t.Helper()
	e.Exec(`UPDATE brands SET portal_auth_mode=$2, portal_sso_protocol='saml', portal_saml_idp_entity_id=$3, portal_saml_idp_sso_url=$4,
        portal_saml_idp_certificates=$5, portal_oidc_create_contacts=$6 WHERE id=$1`, ws.BrandID, mode, samlEntity, samlSSOURL, p.pem, create)
}

// samlOpts changes one thing about a response, to see it refused.
type samlOpts struct {
	nameID, email, name string
	inResponseTo        string // "" answers the request
	audience            string
	notAfter            time.Duration
	notBefore           time.Duration
	recipient           string
	issuer              string
	assertionID         string
	signer              *samlIDP // another provider's key
	sign                string   // "assertion" (default), "response" or "none"
	tamper              func(xml string) string
	status              string
	noAudience          bool
	nameIDFormat        string
}

func (p *samlIDP) response(t *testing.T, ws hdtest.WS, requestID string, o samlOpts) string {
	t.Helper()
	acs := "http://api.test" + ssoPath(ws, "saml/acs")
	sp := "http://api.test" + ssoPath(ws, "saml/metadata")
	or := func(v, d string) string {
		if v != "" {
			return v
		}
		return d
	}
	now := time.Now().UTC()
	irt := or(o.inResponseTo, requestID)
	nb := now.Add(-time.Minute + o.notBefore).Format(time.RFC3339)
	na := now.Add(5*time.Minute + o.notAfter).Format(time.RFC3339)
	if o.notAfter != 0 {
		na = now.Add(o.notAfter).Format(time.RFC3339)
	}
	aid := or(o.assertionID, fmt.Sprintf("_a%d", time.Now().UnixNano()))
	audience := `<saml:AudienceRestriction><saml:Audience>` + or(o.audience, sp) + `</saml:Audience></saml:AudienceRestriction>`
	if o.noAudience {
		audience = ""
	}
	attrs := ""
	if o.email != "" {
		attrs += `<saml:Attribute Name="email"><saml:AttributeValue>` + o.email + `</saml:AttributeValue></saml:Attribute>`
	}
	if o.name != "" {
		attrs += `<saml:Attribute Name="name"><saml:AttributeValue>` + o.name + `</saml:AttributeValue></saml:Attribute>`
	}
	status := or(o.status, "urn:oasis:names:tc:SAML:2.0:status:Success")
	doc := fmt.Sprintf(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r%d" Version="2.0" IssueInstant="%s" Destination="%s" InResponseTo="%s">`+
		`<saml:Issuer>%s</saml:Issuer><samlp:Status><samlp:StatusCode Value="%s"/></samlp:Status>`+
		`<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="%s" Version="2.0" IssueInstant="%s"><saml:Issuer>%s</saml:Issuer>`+
		`<saml:Subject><saml:NameID Format="%s">%s</saml:NameID>`+
		`<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="%s" Recipient="%s" InResponseTo="%s"/></saml:SubjectConfirmation></saml:Subject>`+
		`<saml:Conditions NotBefore="%s" NotOnOrAfter="%s">%s</saml:Conditions>`+
		`<saml:AuthnStatement AuthnInstant="%s"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`+
		`<saml:AttributeStatement>%s</saml:AttributeStatement></saml:Assertion></samlp:Response>`,
		time.Now().UnixNano(), now.Format(time.RFC3339), acs, irt, or(o.issuer, samlEntity), status,
		aid, now.Format(time.RFC3339), or(o.issuer, samlEntity), or(o.nameIDFormat, "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"), or(o.nameID, "name-id-1"), na, or(o.recipient, acs), irt,
		nb, na, audience, now.Format(time.RFC3339), attrs)

	d := etree.NewDocument()
	if err := d.ReadFromString(doc); err != nil {
		t.Fatal(err)
	}
	signer := p
	if o.signer != nil {
		signer = o.signer
	}
	ks := dsig.TLSCertKeyStore(tls.Certificate{Certificate: [][]byte{signer.cert}, PrivateKey: signer.key})
	sc := dsig.NewDefaultSigningContext(ks)
	sc.Canonicalizer = dsig.MakeC14N10ExclusiveCanonicalizerWithPrefixList("")
	if err := sc.SetSignatureMethod(dsig.RSASHA256SignatureMethod); err != nil {
		t.Fatal(err)
	}
	switch or(o.sign, "assertion") {
	case "assertion":
		a := d.Root().FindElement("./Assertion")
		signed, err := sc.SignEnveloped(a)
		if err != nil {
			t.Fatal(err)
		}
		d.Root().RemoveChild(a)
		d.Root().AddChild(signed)
	case "response":
		signed, err := sc.SignEnveloped(d.Root())
		if err != nil {
			t.Fatal(err)
		}
		d.SetRoot(signed)
	}
	out, err := d.WriteToString()
	if err != nil {
		t.Fatal(err)
	}
	if o.tamper != nil {
		out = o.tamper(out)
	}
	return base64.StdEncoding.EncodeToString([]byte(out))
}

// samlSignIn runs start and the assertion consumer as a browser would. tweak may change what
// the browser posts back.
func samlSignIn(t *testing.T, e *hdtest.Env, ws hdtest.WS, p *samlIDP, o samlOpts, tweak func(form url.Values, cookie *string)) ssoResult {
	t.Helper()
	start := e.Do("GET", ssoPath(ws, "start")+"?redirect_to="+url.QueryEscape("/portal/"+ws.Slug+"/tickets"), hdtest.Auth{}, nil)
	if start.Status != http.StatusFound {
		t.Fatalf("start status %d: %s", start.Status, start.Body)
	}
	loc, err := url.Parse(start.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if loc.Scheme+"://"+loc.Host+loc.Path != samlSSOURL {
		return ssoResult{Location: loc.String()}
	}
	raw, err := base64.StdEncoding.DecodeString(loc.Query().Get("SAMLRequest"))
	if err != nil {
		t.Fatal(err)
	}
	xmlReq, err := io.ReadAll(flate.NewReader(bytes.NewReader(raw)))
	if err != nil {
		t.Fatal(err)
	}
	req := etree.NewDocument()
	if err := req.ReadFromBytes(xmlReq); err != nil {
		t.Fatal(err)
	}
	id := req.Root().SelectAttrValue("ID", "")
	if id == "" || req.Root().SelectAttrValue("AssertionConsumerServiceURL", "") != "http://api.test"+ssoPath(ws, "saml/acs") ||
		req.Root().SelectAttrValue("Destination", "") != samlSSOURL {
		t.Fatalf("authn request %s", xmlReq)
	}
	cookie := ""
	for _, c := range (&http.Response{Header: http.Header{"Set-Cookie": start.Header.Values("Set-Cookie")}}).Cookies() {
		if c.Name == ssoBindCookie+"_saml" {
			cookie = c.Value
		}
	}
	form := url.Values{"SAMLResponse": {p.response(t, ws, id, o)}, "RelayState": {loc.Query().Get("RelayState")}}
	if tweak != nil {
		tweak(form, &cookie)
	}
	h := map[string]string{"Content-Type": "application/x-www-form-urlencoded"}
	if cookie != "" {
		h["Cookie"] = ssoBindCookie + "_saml=" + cookie
	}
	res := e.Do("POST", ssoPath(ws, "saml/acs"), hdtest.Auth{Header: h}, form.Encode())
	if res.Status != http.StatusFound {
		t.Fatalf("acs status %d: %s", res.Status, res.Body)
	}
	return ssoResult{Location: res.Header.Get("Location"), Cookies: (&http.Response{Header: http.Header{"Set-Cookie": res.Header.Values("Set-Cookie")}}).Cookies()}
}

func TestSAMLSignInLinksVerifiedContactAndOpensSession(t *testing.T) {
	e, ws, cid, email := portalEnv(t)
	p := newSAMLIDP(t)
	useSAML(t, e, ws, p, "oidc", false)

	refresh := samlSignIn(t, e, ws, p, samlOpts{nameID: "saml-subject-1", email: email, name: "Customer Name"}, nil).mustSucceed(t, ws)
	sessionWorks(t, e, ws, refresh, 200)
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE contact_id=$1 AND issuer=$2 AND subject='saml-subject-1' AND revoked_at IS NULL`, cid, "saml:"+samlEntity); n != 1 {
		t.Fatalf("identity rows %d", n)
	}
	if n := count(e, `SELECT count(*) FROM customer_sessions WHERE contact_id=$1 AND method='saml'`, cid); n != 1 {
		t.Fatalf("saml sessions %d", n)
	}
	if n := count(e, `SELECT count(*) FROM customer_credentials WHERE contact_id=$1`, cid); n != 0 {
		t.Fatal("a provider sign-in created a password row")
	}
	// The link, not the address, identifies the customer on later sign-ins.
	samlSignIn(t, e, ws, p, samlOpts{nameID: "saml-subject-1", email: "renamed@example.com"}, nil).mustSucceed(t, ws)
	if n := count(e, `SELECT count(*) FROM customer_oidc_identities WHERE contact_id=$1`, cid); n != 1 {
		t.Fatalf("a second sign-in added a link: %d", n)
	}
}

func TestSAMLSignInSigningVariants(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	p := newSAMLIDP(t)
	useSAML(t, e, ws, p, "oidc", false)
	// A provider may sign the response instead of the assertion.
	samlSignIn(t, e, ws, p, samlOpts{nameID: "s-resp", email: email, sign: "response"}, nil).mustSucceed(t, ws)
	// The NameID is the address when no attribute carries one.
	e2, ws2, _, email2 := portalEnv(t)
	useSAML(t, e2, ws2, p, "oidc", false)
	samlSignIn(t, e2, ws2, p, samlOpts{nameID: email2}, nil).mustSucceed(t, ws2)
}

func TestSAMLRefusals(t *testing.T) {
	e, ws, cid, email := portalEnv(t)
	p := newSAMLIDP(t)
	other := newSAMLIDP(t)
	useSAML(t, e, ws, p, "oidc", false)
	good := func(o samlOpts) samlOpts {
		if o.nameID == "" {
			o.nameID = fmt.Sprintf("s-%d", time.Now().UnixNano())
		}
		if o.email == "" {
			o.email = email
		}
		return o
	}
	refused := func(name string, o samlOpts, code string, tweak func(url.Values, *string)) {
		t.Helper()
		t.Run(name, func(t *testing.T) { samlSignIn(t, e, ws, p, good(o), tweak).mustFail(t, code) })
	}

	refused("unsigned", samlOpts{sign: "none"}, "provider_error", nil)
	refused("another provider's key", samlOpts{signer: other}, "provider_error", nil)
	refused("another issuer", samlOpts{issuer: "https://evil.example.test/entity"}, "provider_error", nil)
	refused("another audience", samlOpts{audience: "https://other-sp.example.test"}, "provider_error", nil)
	refused("no audience at all", samlOpts{noAudience: true}, "provider_error", nil)
	refused("expired", samlOpts{notAfter: -2 * time.Minute, notBefore: -10 * time.Minute}, "provider_error", nil)
	refused("not yet valid", samlOpts{notBefore: 10 * time.Minute}, "provider_error", nil)
	refused("a transient name id", samlOpts{nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"}, "transient_name_id", nil)
	refused("another request's answer", samlOpts{inResponseTo: "_someone-elses-request"}, "provider_error", nil)
	refused("another recipient", samlOpts{recipient: "https://evil.example.test/acs"}, "provider_error", nil)
	refused("a failure status", samlOpts{status: "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"}, "provider_error", nil)
	refused("altered after signing", samlOpts{tamper: func(x string) string { return strings.Replace(x, "name-id-1", "name-id-2", 1) }, nameID: "name-id-1"}, "provider_error", nil)
	refused("no cookie", samlOpts{}, "invalid_state", func(_ url.Values, c *string) { *c = "" })
	refused("someone else's cookie", samlOpts{}, "invalid_state", func(_ url.Values, c *string) { *c = "garbage" })
	refused("another relay state", samlOpts{}, "invalid_state", func(f url.Values, _ *string) { f.Set("RelayState", "other") })
	refused("no response", samlOpts{}, "invalid_request", func(f url.Values, _ *string) { f.Del("SAMLResponse") })
	refused("no address", samlOpts{email: "x", nameID: "no-address"}, "email_unverified", nil)

	// An assertion works once: the same one posted again is refused.
	samlSignIn(t, e, ws, p, good(samlOpts{assertionID: "_replayed", nameID: "s-replay"}), nil).mustSucceed(t, ws)
	samlSignIn(t, e, ws, p, good(samlOpts{assertionID: "_replayed", nameID: "s-replay"}), nil).mustFail(t, "invalid_state")

	// A refused sign-in leaves no link and no session of its own.
	if n := count(e, `SELECT count(*) FROM customer_sessions WHERE contact_id=$1`, cid); n != 1 {
		t.Fatalf("%d sessions", n)
	}
}

// A provider whose clock runs a little ahead of ours signs with a NotBefore in our future.
func TestSAMLClockSkew(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	p := newSAMLIDP(t)
	useSAML(t, e, ws, p, "oidc", false)
	// The response builder starts NotBefore a minute ago; these move it 30 seconds and 5 minutes ahead.
	samlSignIn(t, e, ws, p, samlOpts{nameID: "s-skew", email: email, notBefore: 90 * time.Second}, nil).mustSucceed(t, ws)
	samlSignIn(t, e, ws, p, samlOpts{nameID: "s-skew", email: email, notBefore: 6 * time.Minute}, nil).mustFail(t, "provider_error")
}

func TestSAMLBrandSettings(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	p := newSAMLIDP(t)
	// A brand in local mode, or with an incomplete provider, offers no SAML.
	r := e.Do("GET", ssoPath(ws, "start"), hdtest.Auth{}, nil)
	if (ssoResult{Location: r.Header.Get("Location")}).error() != "sso_unavailable" {
		t.Fatalf("local brand started: %s", r.Header.Get("Location"))
	}
	useSAML(t, e, ws, p, "local_and_oidc", false)
	// A SAML brand's OIDC callback is not a way in.
	cb := e.Do("GET", ssoPath(ws, "callback")+"?code=x&state=y", hdtest.Auth{}, nil)
	if (ssoResult{Location: cb.Header.Get("Location")}).error() == "" {
		t.Fatal("the OIDC callback answered a SAML brand")
	}
	samlSignIn(t, e, ws, p, samlOpts{nameID: "s-both", email: email}, nil).mustSucceed(t, ws)

	// Switching to OIDC ends a SAML session at the next refresh.
	refresh := samlSignIn(t, e, ws, p, samlOpts{nameID: "s-both", email: email}, nil).mustSucceed(t, ws)
	sessionWorks(t, e, ws, refresh, 200)
	e.Exec(`UPDATE brands SET portal_sso_protocol='oidc', portal_oidc_issuer='https://issuer.example', portal_oidc_client_id='c', portal_oidc_client_secret_enc='\x01' WHERE id=$1`, ws.BrandID)
	sessionWorks(t, e, ws, refresh, 401)
}

func TestSAMLMetadata(t *testing.T) {
	e, ws, _, _ := portalEnv(t)
	r := e.Do("GET", ssoPath(ws, "saml/metadata"), hdtest.Auth{}, nil).Want(t, 200)
	if ct := r.Header.Get("Content-Type"); !strings.Contains(ct, "samlmetadata+xml") {
		t.Fatalf("content type %q", ct)
	}
	body := string(r.Body)
	for _, want := range []string{`entityID="http://api.test` + ssoPath(ws, "saml/metadata") + `"`, `Location="http://api.test` + ssoPath(ws, "saml/acs") + `"`, "HTTP-POST", `WantAssertionsSigned="true"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("metadata lacks %s:\n%s", want, body)
		}
	}
	e.Do("GET", "/v1/public/help/no-such-brand/portal/sso/saml/metadata", hdtest.Auth{}, nil).Want(t, 404)
}
