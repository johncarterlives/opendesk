package core

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/config"
)

// An OIDC_ISSUER matches the issuer the provider advertises with or without a trailing
// slash, and a different issuer is still refused.
func TestOIDCIssuerTrailingSlash(t *testing.T) {
	var advertised string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/application/o/opendesk/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 advertised,
			"authorization_endpoint": advertised + "authorize",
			"token_endpoint":         advertised + "token",
			"jwks_uri":               advertised + "jwks",
		})
	}))
	defer srv.Close()
	base := srv.URL + "/application/o/opendesk"

	for _, tc := range []struct {
		name, configured, advertised string
		ok                           bool
	}{
		{"slash advertised, none configured", base, base + "/", true},
		{"slash advertised and configured", base + "/", base + "/", true},
		{"none advertised, slash configured", base + "/", base, true},
		{"none advertised or configured", base, base, true},
		{"another issuer", base, srv.URL + "/application/o/other/", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			advertised = tc.advertised
			ps := newOAuthProviders(&config.Config{OIDCIssuer: tc.configured, OIDCClientID: "client"})
			c, err := ps.ensure(context.Background(), ps.byID["oidc"])
			if !tc.ok {
				if err == nil || !strings.Contains(err.Error(), "does not match") {
					t.Fatalf("err = %v, want an issuer mismatch", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.Endpoint.AuthURL != tc.advertised+"authorize" {
				t.Fatalf("auth url = %q", c.Endpoint.AuthURL)
			}
		})
	}
}
