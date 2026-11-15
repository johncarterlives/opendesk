package brands_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/useopendesk/opendesk/internal/helpdesk/brands"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
)

func samlCert(t *testing.T, bits int, notAfter time.Time) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "idp.example.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestPortalSAMLSettings(t *testing.T) {
	e := hdtest.New(t, brands.Register)
	ws := e.NewWorkspace()
	path := "/v1/brands/" + ws.BrandID.String()
	admin := ws.Admin.As(ws)
	good := samlCert(t, 2048, time.Now().Add(24*time.Hour))
	saml := func(mod func(m map[string]any)) map[string]any {
		s := map[string]any{"idp_entity_id": "https://idp.example.test/entity", "idp_sso_url": "https://idp.example.test/sso", "idp_certificates": good}
		in := map[string]any{"mode": "local_and_oidc", "protocol": "saml", "create_contacts": true, "saml": s}
		if mod != nil {
			mod(s)
		}
		return map[string]any{"portal_auth": in}
	}

	e.Do("PATCH", path, admin, saml(nil)).Want(t, 200)
	var out struct {
		Mode, Protocol   string
		CreateContacts   bool `json:"create_contacts"`
		SecretConfigured bool `json:"secret_configured"`
		SAML             struct {
			IdPEntityID     string `json:"idp_entity_id"`
			IdPCertificates string `json:"idp_certificates"`
			SPEntityID      string `json:"sp_entity_id"`
			ACSURL          string `json:"acs_url"`
		}
	}
	res := e.Do("GET", path+"/portal/auth", admin, nil).Want(t, 200)
	res.JSON(t, &out)
	if out.Mode != "local_and_oidc" || out.Protocol != "saml" || !out.CreateContacts || out.SecretConfigured || out.SAML.IdPEntityID != "https://idp.example.test/entity" ||
		!strings.HasPrefix(out.SAML.IdPCertificates, "-----BEGIN CERTIFICATE-----") ||
		!strings.HasSuffix(out.SAML.SPEntityID, "/portal/sso/saml/metadata") || !strings.HasSuffix(out.SAML.ACSURL, "/portal/sso/saml/acs") {
		t.Fatalf("settings %s", res.Body)
	}
	var protocol string
	e.Scalar(`SELECT portal_sso_protocol FROM brands WHERE id = $1`, &protocol, ws.BrandID)
	if protocol != "saml" {
		t.Fatalf("stored %q", protocol)
	}
	var logged int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'brand.portal_auth_updated' AND data->>'protocol' = 'saml'`, &logged, ws.ID)
	if logged != 1 {
		t.Fatalf("audited %d", logged)
	}

	// What cannot be a provider is refused, naming nothing of what was sent.
	for name, body := range map[string]map[string]any{
		"no entity id":     saml(func(s map[string]any) { s["idp_entity_id"] = "" }),
		"http sign-in URL": saml(func(s map[string]any) { s["idp_sso_url"] = "http://idp.example.test/sso" }),
		"no certificate":   saml(func(s map[string]any) { s["idp_certificates"] = "" }),
		"not a certificate": saml(func(s map[string]any) {
			s["idp_certificates"] = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"
		}),
		"a small key":     saml(func(s map[string]any) { s["idp_certificates"] = samlCert(t, 1024, time.Now().Add(time.Hour)) }),
		"an expired one":  saml(func(s map[string]any) { s["idp_certificates"] = samlCert(t, 2048, time.Now().Add(-time.Minute)) }),
		"four of them":    saml(func(s map[string]any) { s["idp_certificates"] = strings.Repeat(good, 4) }),
		"no saml section": {"portal_auth": map[string]any{"mode": "oidc", "protocol": "saml"}},
		"a client secret": {"portal_auth": map[string]any{"mode": "oidc", "protocol": "saml", "client_secret": "x", "saml": map[string]any{"idp_entity_id": "e", "idp_sso_url": "https://a.test/s", "idp_certificates": good}}},
		"saml with oidc":  {"portal_auth": map[string]any{"mode": "oidc", "protocol": "oidc", "client_id": "c", "saml": map[string]any{"idp_entity_id": "e", "idp_sso_url": "https://a.test/s", "idp_certificates": good}}},
		"local with saml": {"portal_auth": map[string]any{"mode": "local", "saml": map[string]any{"idp_entity_id": "e", "idp_sso_url": "https://a.test/s", "idp_certificates": good}}},
	} {
		if r := e.Do("PATCH", path, admin, body); r.Status != 422 {
			t.Errorf("%s: status %d: %s", name, r.Status, r.Body)
		}
	}

	// Another workspace's admin, and a member below admin, cannot read or change it.
	other := e.NewWorkspace()
	e.Do("GET", path+"/portal/auth", other.Admin.As(other), nil).Want(t, 404)
	e.Do("GET", path+"/portal/auth", ws.Agent.As(ws), nil).Want(t, 403)

	// Local clears the provider.
	e.Do("PATCH", path, admin, map[string]any{"portal_auth": map[string]any{"mode": "local"}}).Want(t, 200)
	var entity, protocol2 string
	e.Scalar(`SELECT portal_saml_idp_entity_id FROM brands WHERE id = $1`, &entity, ws.BrandID)
	e.Scalar(`SELECT portal_sso_protocol FROM brands WHERE id = $1`, &protocol2, ws.BrandID)
	if entity != "" || protocol2 != "oidc" {
		t.Fatalf("local left %q %q", entity, protocol2)
	}
}
