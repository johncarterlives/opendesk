package customerportal

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/captcha"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

func TestMain(m *testing.M) { hdtest.Main(m) }

const password = "Portal-customer!7-candle"

func portalEnv(t *testing.T) (*hdtest.Env, hdtest.WS, uuid.UUID, string) {
	t.Helper()
	address := uuid.New()
	remote := net.JoinHostPort(net.IP(address[:]).String(), "1234")
	e := hdtest.New(t, func(d *deps.Deps, api huma.API, r chi.Router) {
		api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
			r, _ := humachi.Unwrap(ctx)
			r.RemoteAddr = remote
			next(ctx)
		})
		d.Captcha = captcha.NewTurnstileFromConfig(captcha.TurnstileConfig{Disabled: true})
		d.Limiter = httpx.NewLimiter()
		d.Limiter.UseDB(d.DB.Pool, d.Log)
		Register(d, api, r)
		contacts.Register(d, api, r)
		huma.Register(api, huma.Operation{OperationID: "customer-test", Method: "GET", Path: "/customer-test"}, func(ctx context.Context, _ *struct{}) (*struct{ Body *auth.Principal }, error) {
			p, err := auth.RequireCustomer(ctx)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body *auth.Principal }{p}, nil
		})
		huma.Register(api, huma.Operation{OperationID: "member-test", Method: "GET", Path: "/member-test"}, func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			_, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeTicketsRead)
			return nil, httpx.Wrap(err)
		})
	})
	ws := e.NewWorkspace()
	e.Exec(`UPDATE brands SET help_center_enabled=true, help_center_title='Customer help',color='#123456',locale='fr' WHERE id=$1`, ws.BrandID)
	id := ids.New()
	email := "customer-" + id.String() + "@example.com"
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,$3,'Customer')`, id, ws.ID, email)
	return e, ws, id, email
}
func base(ws hdtest.WS) string         { return "/v1/public/help/" + ws.Slug + "/portal" }
func body(email string) map[string]any { return map[string]any{"email": email, "password": password} }
func setupToken(t *testing.T, e *hdtest.Env, ws hdtest.WS, email string) string {
	t.Helper()
	e.Do("POST", base(ws)+"/auth/forgot", hdtest.Auth{}, map[string]any{"email": email}).Want(t, 204)
	queued := e.Jobs((jobs.CustomerPortalForgotArgs{}).Kind(), ws.ID)
	if len(queued) != 1 {
		t.Fatalf("forgot jobs: %d", len(queued))
	}
	var a jobs.CustomerPortalForgotArgs
	if err := json.Unmarshal(queued[0], &a); err != nil {
		t.Fatal(err)
	}
	if err := (&forgotWorker{d: e.D}).Work(e.Ctx, &river.Job[jobs.CustomerPortalForgotArgs]{Args: a}); err != nil {
		t.Fatal(err)
	}
	var text string
	e.Scalar(`SELECT args->>'text' FROM river_job WHERE kind='mail.system' AND args->>'to'=$1 ORDER BY id DESC LIMIT 1`, &text, email)
	for _, word := range strings.Fields(text) {
		if strings.Contains(word, "/reset#token=") {
			u, err := url.Parse(word)
			if err != nil {
				t.Fatal(err)
			}
			fragment, err := url.ParseQuery(u.Fragment)
			if err != nil {
				t.Fatal(err)
			}
			return fragment.Get("token")
		}
	}
	t.Fatalf("no reset link: %s", text)
	return ""
}
func reset(t *testing.T, e *hdtest.Env, ws hdtest.WS, tok string) *hdtest.Resp {
	t.Helper()
	return e.Do("POST", base(ws)+"/auth/reset", hdtest.Auth{}, map[string]any{"token": tok, "password": password})
}
func signIn(t *testing.T, e *hdtest.Env, ws hdtest.WS, email string) (string, string) {
	t.Helper()
	r := e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 200)
	m := r.Map(t)
	delete(m, "$schema")
	if len(m) != 2 || m["refresh_token"] != nil {
		t.Fatalf("auth body: %s", r.Body)
	}
	cs := (&http.Response{Header: r.Header}).Cookies()
	if len(cs) != 1 || !cs[0].HttpOnly || cs[0].Domain != "" || cs[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie: %+v", cs)
	}
	return m["access_token"].(string), cs[0].Name + "=" + cs[0].Value
}
func TestConfigAndUnknownLogin(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	r := e.Do("GET", base(ws)+"/config", hdtest.Auth{}, nil).Want(t, 200)
	m := r.Map(t)
	delete(m, "$schema")
	if len(m) != 6 || m["title"] != "Customer help" || m["color"] != "#123456" || m["locale"] != "fr" || m["help_url"] != e.D.Cfg.HelpCenterURL(ws.Slug) {
		t.Fatalf("config: %s", r.Body)
	}
	e.Exec(`INSERT INTO help_domains (workspace_id, brand_id, hostname, token, status, verified_at) VALUES ($1, $2, $3, 't', 'active', now())`, ws.ID, ws.BrandID, ws.Slug+".example.com")
	if got := e.Do("GET", base(ws)+"/config", hdtest.Auth{}, nil).Want(t, 200).Map(t)["help_url"]; got != "https://"+ws.Slug+".example.com" {
		t.Fatalf("custom help URL: %v", got)
	}
	known := e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 401)
	unknown := e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body("unknown@example.com")).Want(t, 401)
	if known.Map(t)["code"] != unknown.Map(t)["code"] || known.Map(t)["detail"] != unknown.Map(t)["detail"] {
		t.Fatal("login reveals identity")
	}
	e.Do("POST", base(ws)+"/auth/forgot", hdtest.Auth{}, map[string]any{"email": "unknown@example.com"}).Want(t, 204)
	e.Exec(`UPDATE brands SET help_center_enabled=false WHERE id=$1`, ws.BrandID)
	e.Do("GET", base(ws)+"/config", hdtest.Auth{}, nil).Want(t, 404)
}
func TestPasswordSetupRotationAndReset(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	tok := setupToken(t, e, ws, email)
	var hash []byte
	e.Scalar(`SELECT token_hash FROM customer_password_resets WHERE contact_id=$1`, &hash, id)
	if string(hash) == tok || len(hash) == 0 {
		t.Fatal("reset credential is not hashed")
	}
	other := e.NewWorkspace()
	e.Exec(`UPDATE brands SET help_center_enabled=true WHERE id=$1`, other.BrandID)
	reset(t, e, other, tok).Want(t, 400)
	reset(t, e, ws, tok).Want(t, 204)
	reset(t, e, ws, tok).Want(t, 400)
	access, cookie := signIn(t, e, ws, email)
	var principal auth.Principal
	e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access, Workspace: other.ID}, nil).Want(t, 200).JSON(t, &principal)
	if principal.WorkspaceID != ws.ID || principal.ContactID != id || principal.SessionID == uuid.Nil || principal.Kind != auth.KindCustomer ||
		principal.UserID != uuid.Nil || principal.APIKeyID != uuid.Nil || principal.VisitorID != uuid.Nil || principal.Role != "" || len(principal.Scopes) != 0 {
		t.Fatalf("customer principal: %+v", principal)
	}
	e.Do("GET", "/member-test", hdtest.Auth{Bearer: access, Workspace: ws.ID}, nil).Want(t, 401)
	e.Do("GET", "/customer-test", ws.Owner.As(ws), nil).Want(t, 401)
	e.D.Cfg.CORSOrigins = []string{e.D.Cfg.AppURL, "https://other-allowed.test"}
	e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": cookie, "Origin": "https://other-allowed.test"}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 401)
	r := e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": cookie}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 200)
	next := (&http.Response{Header: r.Header}).Cookies()[0]
	if next.Name+"="+next.Value == cookie {
		t.Fatal("refresh did not rotate")
	}
	e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": cookie}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 401)
	e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": next.Name + "=" + next.Value, "Origin": "https://foreign.test"}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 401)
	e.Do("POST", "/v1/customer/portal/auth/logout", hdtest.Auth{Bearer: access}, nil).Want(t, 204)
	e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
	access, _ = signIn(t, e, ws, email)
	tok = setupToken(t, e, ws, email)
	newPassword := "Changed-portal!8-candle"
	e.Do("POST", base(ws)+"/auth/reset", hdtest.Auth{}, map[string]any{"token": tok, "password": newPassword}).Want(t, 204)
	e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 401)
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, map[string]any{"email": email, "password": newPassword}).Want(t, 200)
	for _, action := range []string{"customer.login", "customer.login.failed", "customer.logout", "customer.password.reset"} {
		var count int
		e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND entity_id=$2 AND action=$3 AND actor_user_id IS NULL AND actor_api_key_id IS NULL`, &count, ws.ID, id, action)
		if count == 0 {
			t.Fatalf("missing customer audit event: %s", action)
		}
	}
}
func TestContactLifecycle(t *testing.T) {
	for _, change := range []string{"blocked", "email", "deleted", "suspended", "expired"} {
		t.Run(change, func(t *testing.T) {
			e, ws, id, email := portalEnv(t)
			tok := setupToken(t, e, ws, email)
			reset(t, e, ws, tok).Want(t, 204)
			access, cookie := signIn(t, e, ws, email)
			tok = setupToken(t, e, ws, email)
			switch change {
			case "blocked":
				e.Do("PATCH", "/v1/contacts/"+id.String(), ws.Agent.As(ws), map[string]any{"blocked": true}).Want(t, 200)
			case "email":
				e.Do("PATCH", "/v1/contacts/"+id.String(), ws.Agent.As(ws), map[string]any{"email": "changed-" + email}).Want(t, 200)
			case "deleted":
				e.Do("DELETE", "/v1/contacts/"+id.String(), ws.Agent.As(ws), nil).Want(t, 204)
			case "suspended":
				e.Exec(`UPDATE workspaces SET suspended_at=now() WHERE id=$1`, ws.ID)
			case "expired":
				e.Exec(`UPDATE customer_sessions SET expires_at=now()-interval '1 second' WHERE contact_id=$1`, id)
			}
			e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
			e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": cookie}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 401)
			if change == "blocked" || change == "email" || change == "deleted" {
				reset(t, e, ws, tok).Want(t, 400)
			}
			if change == "blocked" {
				e.Exec(`UPDATE contacts SET blocked=false WHERE id=$1`, id)
				e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
			}
		})
	}
}
func TestResetExpiryAndLimits(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	tok := setupToken(t, e, ws, email)
	e.Exec(`UPDATE customer_password_resets SET expires_at=now()-interval '1 second' WHERE contact_id=$1`, id)
	reset(t, e, ws, tok).Want(t, 400)
	for i := 0; i < 10; i++ {
		e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 401)
	}
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 429)
	// A new API process sees the same account budget.
	e.D.Limiter = httpx.NewLimiter()
	e.D.Limiter.UseDB(e.D.DB.Pool, e.D.Log)
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 429)
	// A configured human check gates setup and login, before the account budget.
	e.D.Captcha = captcha.NewTurnstileFromConfig(captcha.TurnstileConfig{})
	e.Do("POST", base(ws)+"/auth/forgot", hdtest.Auth{}, map[string]any{"email": email}).Want(t, 400)
}

func TestCustomerSnapshotsAndSessionCap(t *testing.T) {
	for _, snapshot := range []string{"session", "credential", "workspace claim", "contact claim"} {
		t.Run(snapshot, func(t *testing.T) {
			e, ws, id, email := portalEnv(t)
			reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)
			access, cookie := signIn(t, e, ws, email)
			switch snapshot {
			case "session":
				e.Exec(`UPDATE customer_sessions SET email='someone-else@example.com' WHERE contact_id=$1`, id)
			case "credential":
				e.Exec(`UPDATE customer_credentials SET email='someone-else@example.com' WHERE contact_id=$1`, id)
			case "workspace claim", "contact claim":
				claims, err := e.D.Tokens.Verify(access, auth.PurposeCustomerAccess)
				if err != nil {
					t.Fatal(err)
				}
				if snapshot == "workspace claim" {
					claims.Workspace = uuid.NewString()
				} else {
					claims.Subject = uuid.NewString()
				}
				access, _, err = e.D.Tokens.Sign(*claims, claims.Subject, time.Minute)
				if err != nil {
					t.Fatal(err)
				}
			}
			e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
			if snapshot == "session" || snapshot == "credential" {
				e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": cookie}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 401)
			}
		})
	}
	e, ws, id, email := portalEnv(t)
	reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)
	_, cookie := signIn(t, e, ws, email)
	var before time.Time
	e.Scalar(`SELECT expires_at FROM customer_sessions WHERE contact_id=$1`, &before, id)
	r := e.Do("POST", "/v1/customer/portal/auth/refresh", hdtest.Auth{Header: map[string]string{"Cookie": cookie}}, map[string]any{"workspace_slug": ws.Slug}).Want(t, 200)
	var after time.Time
	e.Scalar(`SELECT expires_at FROM customer_sessions WHERE contact_id=$1`, &after, id)
	if !before.Equal(after) {
		t.Fatal("refresh extended absolute session lifetime")
	}
	c := (&http.Response{Header: r.Header}).Cookies()[0]
	if c.Value == "" {
		t.Fatal("missing refresh")
	}
	var stored []byte
	e.Scalar(`SELECT refresh_hash FROM customer_sessions WHERE contact_id=$1`, &stored, id)
	if string(stored) == c.Value || len(stored) != 32 {
		t.Fatal("refresh must be stored hashed")
	}
	// Every failed password performs the same check and receives the same response.
	bad := body(email)
	bad["password"] = "incorrect-password"
	known := e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, bad).Want(t, 401)
	bad["email"] = "unknown@example.com"
	unknown := e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, bad).Want(t, 401)
	if known.Map(t)["detail"] != unknown.Map(t)["detail"] || known.Map(t)["code"] != unknown.Map(t)["code"] {
		t.Fatal("wrong-password response reveals identity")
	}
}

func TestResetInvalidatesOtherLinksAndChecksPassword(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	first := setupToken(t, e, ws, email)
	second := setupToken(t, e, ws, email)
	e.Do("POST", base(ws)+"/auth/reset", hdtest.Auth{}, map[string]any{"token": first, "password": "short"}).Want(t, 422)
	reset(t, e, ws, first).Want(t, 204)
	reset(t, e, ws, second).Want(t, 400)
	// Both successful setup and later reset send a security notice in their transaction.
	var n int
	e.Scalar(`SELECT count(*) FROM river_job WHERE kind='mail.system' AND args->>'to'=$1 AND args->>'subject'='Your customer portal password was changed'`, &n, email)
	if n != 1 {
		t.Fatalf("security notices: %d", n)
	}
}

func TestForgotEligibilityAndUniformResponse(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	var initial int
	e.Scalar(`SELECT count(*) FROM customer_credentials WHERE contact_id=$1`, &initial, id)
	if initial != 0 {
		t.Fatal("contact creation initialized portal password")
	}
	e.Exec(`UPDATE contacts SET blocked=true WHERE id=$1`, id)
	for _, address := range []string{email, "unknown@example.com"} {
		e.Do("POST", base(ws)+"/auth/forgot", hdtest.Auth{}, map[string]any{"email": address}).Want(t, 204)
	}
	for _, raw := range e.Jobs((jobs.CustomerPortalForgotArgs{}).Kind(), ws.ID) {
		var args jobs.CustomerPortalForgotArgs
		if err := json.Unmarshal(raw, &args); err != nil {
			t.Fatal(err)
		}
		if err := (&forgotWorker{d: e.D}).Work(e.Ctx, &river.Job[jobs.CustomerPortalForgotArgs]{Args: args}); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	e.Scalar(`SELECT count(*) FROM customer_password_resets WHERE workspace_id=$1`, &n, ws.ID)
	if n != 0 {
		t.Fatal("ineligible contact received reset token")
	}
}

func TestCustomerCookieHTTPS(t *testing.T) {
	e, _, _, _ := portalEnv(t)
	cfg := *e.D.Cfg
	cfg.APIURL = "https://api.test"
	cfg.CookieDomain = ".test"
	d := *e.D
	d.Cfg = &cfg
	s := &service{d: &d}
	value := s.cookie("secret", 60)
	c := (&http.Response{Header: http.Header{"Set-Cookie": []string{value}}}).Cookies()[0]
	if c.Name != "__Host-od_customer_refresh" || !c.Secure || !c.HttpOnly || c.Domain != "" || c.Path != "/" || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie: %+v", c)
	}
}

func TestHumanCheckUsesAppHostname(t *testing.T) {
	for _, hostname := range []string{"app.test", "admin.test"} {
		t.Run(hostname, func(t *testing.T) {
			e, ws, _, email := portalEnv(t)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(captcha.Response{Success: true, Hostname: hostname})
			}))
			defer srv.Close()
			e.D.Captcha = captcha.NewTurnstileFromConfig(captcha.TurnstileConfig{
				Secret: "test-key", SiteVerifyURL: srv.URL, Hostnames: []string{"app.test", "admin.test"},
			})
			for _, route := range []string{"login", "forgot", "reset"} {
				request := map[string]any{"turnstile_token": "challenge"}
				if route == "reset" {
					request["token"] = "invalid"
				} else {
					request["email"] = email
				}
				if route != "forgot" {
					request["password"] = password
				}
				r := e.Do("POST", base(ws)+"/auth/"+route, hdtest.Auth{}, request)
				if hostname != "app.test" {
					if r.Want(t, 400).Map(t)["code"] != "captcha_failed" {
						t.Fatalf("%s accepted a challenge from %s", route, hostname)
					}
					continue
				}
				switch route {
				case "forgot":
					r.Want(t, 204)
				case "login":
					if r.Want(t, 401).Map(t)["code"] != "invalid_credentials" {
						t.Fatal("login rejected an app-origin challenge")
					}
				case "reset":
					if r.Want(t, 400).Map(t)["code"] != "invalid_token" {
						t.Fatal("reset rejected an app-origin challenge")
					}
				}
			}
		})
	}
}

func TestLoginReadsPasswordAfterContactLock(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)
	newHash, err := auth.HashPassword("Changed-portal!8-candle")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(e.Ctx, 10*time.Second)
	defer cancel()
	tx, err := e.D.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(e.Ctx)
	var pid int
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM contacts WHERE id=$1 FOR UPDATE`, id).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := (&service{d: e.D}).login(ctx, ws.Slug, loginBody{Email: email, Password: password})
		result <- err
	}()
	// Wait until login is queued on the same identity lock used by password reset.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := e.D.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("login did not acquire the contact lock")
		case err := <-result:
			t.Fatalf("login completed before the identity transaction: %v", err)
		case <-ticker.C:
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE customer_credentials SET password_hash=$2 WHERE contact_id=$1`, id, newHash); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if he, ok := err.(*httpx.Error); !ok || he.Code != "invalid_credentials" {
			t.Fatalf("login must read the current password after acquiring the identity lock: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("login did not finish after the identity transaction")
	}
}

func TestLoginFlagsPasswordThatNoLongerMeetsPolicy(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)
	access, _ := signIn(t, e, ws, email)
	oldPassword := "password"
	hash, err := auth.HashPassword(oldPassword)
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`UPDATE customer_credentials SET password_hash=$2 WHERE contact_id=$1`, id, hash)
	r := e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, map[string]any{"email": email, "password": oldPassword}).Want(t, 200)
	if r.Map(t)["change_password"] != true || r.Map(t)["access_token"] != "" {
		t.Fatal("weak password must require reset without issuing a customer access token")
	}
	if cookies := r.Header.Values("Set-Cookie"); len(cookies) != 1 || !strings.Contains(cookies[0], "Max-Age=0") {
		t.Fatalf("weak-password login must clear the refresh cookie: %v", cookies)
	}
	var active int
	e.Scalar(`SELECT count(*) FROM customer_sessions WHERE workspace_id=$1 AND contact_id=$2 AND revoked_at IS NULL`, &active, ws.ID, id)
	if active != 0 {
		t.Fatalf("weak-password login left %d active sessions", active)
	}
	e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
}

func TestRefreshRequiresPortalContext(t *testing.T) {
	e, ws, _, email := portalEnv(t)
	reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)
	_, cookie := signIn(t, e, ws, email)
	other := e.NewWorkspace()
	e.Exec(`UPDATE brands SET help_center_enabled=true WHERE id=$1`, other.BrandID)
	credential := hdtest.Auth{Header: map[string]string{"Cookie": cookie, "Origin": e.D.Cfg.AppURL}}
	e.Do("POST", "/v1/customer/portal/auth/refresh", credential, map[string]any{"workspace_slug": other.Slug}).Want(t, 401)
	e.Do("POST", "/v1/customer/portal/auth/refresh", credential, map[string]any{}).Want(t, 422)
	e.Do("POST", "/v1/customer/portal/auth/refresh", credential, map[string]any{"workspace_slug": ws.Slug}).Want(t, 200)
}
