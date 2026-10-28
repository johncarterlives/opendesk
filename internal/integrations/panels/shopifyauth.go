package panels

// Shopify credentials. Since 2026 a shop's new apps are made in Shopify's Dev Dashboard and
// have a client ID and secret instead of a token to copy: OpenDesk asks the shop for an Admin
// API token with both (the client credentials grant), which lasts 24 hours, and asks again
// shortly before it ends. Shopify answers it only for a shop of the app's own organization
// (shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant).
// Apps made in Shopify admin before 2026 keep a token that never ends, pasted once.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/version"
)

const (
	// maxTokenAnswer bounds the token endpoint's answer.
	maxTokenAnswer = 64 << 10
	// tokenMargin is how long before its end a token is asked for again.
	tokenMargin = 5 * time.Minute
)

// shopifyScopes are what a panel reads with; a write scope includes its read one.
var shopifyScopes = []string{"read_customers", "read_orders"}

// shopifyCred is what a panel connects with: an app's client ID and secret, or an access
// token alone (no client ID).
type shopifyCred struct{ clientID, secret string }

// shopifyCredentials reads what an admin pasted: a client ID and secret, or a token.
func shopifyCredentials(clientID, clientSecret, token string) (shopifyCred, error) {
	clientID, clientSecret, token = strings.TrimSpace(clientID), strings.TrimSpace(clientSecret), strings.TrimSpace(token)
	spaced := func(v string) bool { return strings.ContainsAny(v, " \r\n\t") }
	switch {
	case token != "" && (clientID != "" || clientSecret != ""):
		return shopifyCred{}, errors.New("Give the app's client ID and secret, or an access token, not both.")
	case token != "":
		if spaced(token) {
			return shopifyCred{}, errors.New("Paste the Admin API access token.")
		}
		return shopifyCred{secret: token}, nil
	case clientID == "" || clientSecret == "" || spaced(clientID) || spaced(clientSecret):
		return shopifyCred{}, errors.New("Paste the app's client ID and client secret.")
	}
	return shopifyCred{clientID: clientID, secret: clientSecret}, nil
}

// appToken is an Admin API token Shopify gave an app.
type appToken struct {
	token   string
	scope   string
	expires time.Time
}

// requestAppToken asks the shop for a token with the app's client ID and secret.
func (s *Service) requestAppToken(ctx context.Context, shop string, c shopifyCred) (appToken, error) {
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.clientID}, "client_secret": {c.secret}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.shopifyBase(shop)+"/admin/oauth/access_token",
		strings.NewReader(form.Encode()))
	if err != nil {
		return appToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "opendesk-panels/"+version.Version)
	res, err := s.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // never the URL
		}
		return appToken{}, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxTokenAnswer+1))
	if err != nil {
		return appToken{}, err
	}
	if len(raw) > maxTokenAnswer {
		return appToken{}, errors.New("Shopify's answer is too large.")
	}
	if res.StatusCode >= 300 {
		return appToken{}, tokenRefusal(res.StatusCode, raw)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return appToken{}, errors.New("Shopify's answer has no token.")
	}
	life := time.Duration(out.ExpiresIn) * time.Second
	if life <= 0 {
		life = time.Hour // not said: asked again soon rather than used past its end
	}
	return appToken{token: out.AccessToken, scope: out.Scope, expires: s.tokens.now().Add(life)}, nil
}

// tokenRefusal is the token endpoint's refusal in a few words. Shopify answers an OAuth
// error ({"error", "error_description"}) or a page that names it.
func tokenRefusal(status int, raw []byte) error {
	var e struct {
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	_ = json.Unmarshal(raw, &e)
	said := strings.ToLower(e.Error + " " + e.Description + " " + string(raw[:min(len(raw), 2000)]))
	switch {
	case strings.Contains(said, "shop_not_permitted"):
		return &authError{"Shopify gives this app no token for this shop: the app must belong to the shop's own organization in the Dev Dashboard."}
	case status == http.StatusTooManyRequests:
		return errors.New("Shopify is busy. Try again in a moment.")
	case status == http.StatusBadRequest || status == http.StatusUnauthorized || status == http.StatusForbidden:
		return &authError{"Shopify refused the app's client ID or secret, or the app isn't installed on the shop."}
	}
	return fmt.Errorf("Shopify answered %d.", status)
}

// missingScopes are the scopes a panel needs that the app's token lacks.
func missingScopes(scope string) []string {
	granted := map[string]bool{}
	for _, sc := range strings.Split(scope, ",") {
		granted[strings.TrimSpace(sc)] = true
	}
	missing := []string{}
	for _, need := range shopifyScopes {
		if !granted[need] && !granted["write_"+strings.TrimPrefix(need, "read_")] {
			missing = append(missing, need)
		}
	}
	return missing
}

// appTokens keeps each app panel's current token in this process. Several API processes
// each ask for their own.
type appTokens struct {
	mu  sync.Mutex
	m   map[uuid.UUID]*appTokenSlot
	now func() time.Time
}

// appTokenSlot is one panel's token. Its lock lets one lookup ask Shopify while the others
// wait for that token instead of asking too.
type appTokenSlot struct {
	mu      sync.Mutex
	version int64 // the panel's updated_at: new credentials never use an older token
	tok     appToken
}

func newAppTokens() *appTokens {
	return &appTokens{m: map[uuid.UUID]*appTokenSlot{}, now: time.Now}
}

func (t *appTokens) slot(panel uuid.UUID) *appTokenSlot {
	t.mu.Lock()
	defer t.mu.Unlock()
	sl := t.m[panel]
	if sl == nil {
		sl = &appTokenSlot{}
		t.m[panel] = sl
	}
	return sl
}

// forget drops a removed panel's token.
func (t *appTokens) forget(panel uuid.UUID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.m, panel)
}

// shopifyToken is the panel's Admin API token: the pasted one, or its app's current one,
// asked for when there is none, it ends within tokenMargin, or renew is set. fresh tells
// whether it is pasted or was just asked for, so a refusal of an older one is worth one
// more try with a new one (an app reinstalled or its secret rotated revokes its tokens).
func (s *Service) shopifyToken(ctx context.Context, x *row, renew bool) (token string, fresh bool, err error) {
	secret, err := s.d.Box.Open(x.SecretEnc)
	if err != nil {
		return "", false, err
	}
	if x.ClientID == "" {
		return string(secret), true, nil
	}
	sl := s.tokens.slot(x.ID)
	sl.mu.Lock()
	defer sl.mu.Unlock()
	version := x.UpdatedAt.UnixNano()
	if !renew && sl.version == version && sl.tok.token != "" && s.tokens.now().Add(tokenMargin).Before(sl.tok.expires) {
		return sl.tok.token, false, nil
	}
	tok, err := s.requestAppToken(ctx, x.Target, shopifyCred{clientID: x.ClientID, secret: string(secret)})
	if err != nil {
		return "", false, err
	}
	sl.version, sl.tok = version, tok
	return tok.token, true, nil
}
