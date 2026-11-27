package app

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/config"
)

func TestWebCSPConnectsToOrigins(t *testing.T) {
	csp := webCSP(&config.Config{APIURL: "https://desk.example.com/", GatewayURL: "wss://rt.example.com/socket"})
	var connect string
	for _, d := range strings.Split(csp, "; ") {
		if strings.HasPrefix(d, "connect-src ") {
			connect = d
		}
	}
	for _, want := range []string{"'self'", "https://desk.example.com", "wss://rt.example.com"} {
		if !strings.Contains(connect+" ", " "+want+" ") {
			t.Errorf("connect-src lacks %s: %s", want, connect)
		}
	}
	if strings.Contains(connect, "/socket") {
		t.Errorf("connect-src carries a path, which blocks /socket/websocket: %s", connect)
	}
	if got := cspOrigin("not a url"); got != "" {
		t.Errorf("cspOrigin(junk) = %q", got)
	}
}

// The wiki's embeds load only where the CSP lets them: the web app's list, the self-host
// policy and opendesk Cloud's Pages headers name the same frame origins.
func TestEmbedFrameSourcesAgree(t *testing.T) {
	ts, err := os.ReadFile("../../web/src/lib/wiki/embeds.ts")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)EMBED_ORIGINS = \[(.*?)\] as const`).FindSubmatch(ts)
	if block == nil {
		t.Fatal("EMBED_ORIGINS not found in embeds.ts")
	}
	var web []string
	for _, m := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(block[1], -1) {
		web = append(web, string(m[1]))
	}
	if !slices.Equal(web, embedFrameSources) {
		t.Errorf("embeds.ts %v\napp.go %v", web, embedFrameSources)
	}
	headers, err := os.ReadFile("../../deploy/cloudflare/pages/app/_headers")
	if err != nil {
		t.Fatal(err)
	}
	for _, csp := range []string{webCSP(&config.Config{}), string(headers)} {
		frame := regexp.MustCompile(`frame-src ([^;]+)`).FindStringSubmatch(csp)
		if frame == nil {
			t.Fatalf("no frame-src in %s", csp)
		}
		// The attachment preview shows a PDF from a blob: URL the app made.
		if !slices.Contains(strings.Fields(frame[1]), "blob:") {
			t.Errorf("frame-src lacks blob: %s", frame[1])
		}
		for _, o := range embedFrameSources {
			if !slices.Contains(strings.Fields(frame[1]), o) {
				t.Errorf("frame-src lacks %s: %s", o, frame[1])
			}
		}
	}
}
