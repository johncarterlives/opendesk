// Package webui serves the built web app from the binary (self-hosted single domain).
package webui

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// RuntimeConfig is exposed to the browser as window.__OPENDESK__ via /config.js, and to
// the native apps as the same JSON at /config.json (contracts/native.md).
type RuntimeConfig struct {
	APIURL           string `json:"apiUrl"`
	GatewayURL       string `json:"gatewayUrl"`
	PosthogKey       string `json:"posthogKey,omitempty"`
	PosthogHost      string `json:"posthogHost,omitempty"`
	TurnstileSiteKey string `json:"turnstileSiteKey,omitempty"`
	SelfHosted       bool   `json:"selfHosted"`
	// MailboxOAuth lists the sign-ins the app may offer for a new mailbox ("google",
	// "microsoft"); the API's connect options must allow them too. Always written by
	// this binary, so an empty list hides both.
	MailboxOAuth []string `json:"mailboxOAuth"`
	// MailboxIMAP: mailboxes may receive over IMAP (MAILBOX_IMAP). Off, the app offers
	// forwarding to receive and Google and Microsoft to send only. Always written.
	MailboxIMAP bool `json:"mailboxImap"`
	// HelpDomain puts help centers at <slug>.<helpDomain> (HELP_DOMAIN); empty: at
	// /help/<slug> on this host (contracts/teams.md "Help center addresses").
	HelpDomain string `json:"helpDomain,omitempty"`
}

// Handler serves static assets, /config.js, /config.json, and index.html for client routes.
func Handler(rc RuntimeConfig, csp string) http.Handler {
	sub, _ := fs.Sub(dist, "dist")
	files := http.FileServer(http.FS(sub))
	if rc.MailboxOAuth == nil {
		rc.MailboxOAuth = []string{}
	}
	cfg, _ := json.Marshal(rc)
	configJS := []byte("window.__OPENDESK__=" + string(cfg) + ";")
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		index = []byte(`<!doctype html><meta charset="utf-8"><title>opendesk</title><p>The web app is not built into this binary. Run <code>make web-embed</code>.</p>`)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Frame-Options", "DENY")
		switch r.URL.Path {
		case "/config.js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(configJS)
			return
		case "/config.json":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(cfg)
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p != "" && p != "index.html" {
			if st, err := fs.Stat(sub, p); err == nil && !st.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				// The widget bundle is embedded on customer sites.
				if strings.HasPrefix(p, "widget/") {
					w.Header().Del("X-Frame-Options")
					w.Header().Set("Access-Control-Allow-Origin", "*")
				}
				files.ServeHTTP(w, r)
				return
			}
			// A missing bundle is a 404, never the app page under a script's name.
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "no-store")
				http.NotFound(w, r)
				return
			}
		}
		if r.URL.Path == "/portal" || strings.HasPrefix(r.URL.Path, "/portal/") {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
			w.Header().Set("Referrer-Policy", "no-referrer")
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}
