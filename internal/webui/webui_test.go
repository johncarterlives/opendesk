package webui

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// TestConfigJSON: /config.json is the JSON twin of /config.js, never cached.
func TestConfigJSON(t *testing.T) {
	rc := RuntimeConfig{APIURL: "https://desk.example.com", GatewayURL: "wss://desk.example.com/socket", SelfHosted: true,
		MailboxOAuth: []string{"microsoft"}, MailboxIMAP: true}
	h := Handler(rc, "default-src 'self'")

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/config.json", nil))
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("config.json: %d %v", w.Code, w.Header())
	}
	var got RuntimeConfig
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || !reflect.DeepEqual(got, rc) {
		t.Fatalf("config.json body %s: %v", w.Body.Bytes(), err)
	}

	js := httptest.NewRecorder()
	h.ServeHTTP(js, httptest.NewRequest("GET", "/config.js", nil))
	if !strings.Contains(js.Body.String(), w.Body.String()) {
		t.Fatalf("config.js %q does not carry %q", js.Body.String(), w.Body.String())
	}
}

// TestMailboxOAuthKey: the key is always written, so an empty list hides both sign-ins.
func TestMailboxOAuthKey(t *testing.T) {
	h := Handler(RuntimeConfig{APIURL: "https://desk.example.com", SelfHosted: true}, "default-src 'self'")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/config.json", nil))
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	list, ok := raw["mailboxOAuth"].([]any)
	if !ok || len(list) != 0 {
		t.Fatalf("mailboxOAuth = %#v, want []", raw["mailboxOAuth"])
	}
	// mailboxImap is always written too, so false is said rather than left out.
	if v, ok := raw["mailboxImap"].(bool); !ok || v {
		t.Fatalf("mailboxImap = %#v, want false", raw["mailboxImap"])
	}
}

// TestMissingAssetIs404: a bundle the build does not have is a 404 nothing caches,
// while client routes still get the app page.
func TestMissingAssetIs404(t *testing.T) {
	h := Handler(RuntimeConfig{}, "default-src 'self'")

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/assets/Page-gone1234.js", nil))
	if w.Code != 404 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "<") {
		t.Fatalf("missing asset: %d %v %q", w.Code, w.Header(), w.Body.String())
	}

	page := httptest.NewRecorder()
	h.ServeHTTP(page, httptest.NewRequest("GET", "/settings/billing", nil))
	if page.Code != 200 || !strings.HasPrefix(page.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("client route: %d %v", page.Code, page.Header())
	}
}

func TestPortalHeaders(t *testing.T) {
	h := Handler(RuntimeConfig{}, "default-src 'self'")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/portal/example/reset?token=secret", nil))
	if w.Header().Get("X-Robots-Tag") != "noindex, nofollow" || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("portal headers: %v", w.Header())
	}
}
