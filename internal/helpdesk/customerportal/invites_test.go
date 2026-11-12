package customerportal

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

// invitedToken reads the token of the newest invitation emailed to email.
func invitedToken(t *testing.T, e *hdtest.Env, email string) (subject, token string) {
	t.Helper()
	var text string
	e.Scalar(`SELECT args->>'subject' FROM river_job WHERE kind='mail.system' AND args->>'to'=$1 ORDER BY id DESC LIMIT 1`, &subject, email)
	e.Scalar(`SELECT args->>'text' FROM river_job WHERE kind='mail.system' AND args->>'to'=$1 ORDER BY id DESC LIMIT 1`, &text, email)
	for _, word := range strings.Fields(text) {
		if strings.Contains(word, "/reset#token=") {
			u, err := url.Parse(word)
			if err != nil {
				t.Fatal(err)
			}
			f, _ := url.ParseQuery(u.Fragment)
			return subject, f.Get("token")
		}
	}
	t.Fatalf("no invitation link: %s", text)
	return "", ""
}

func accessOf(t *testing.T, e *hdtest.Env, ws hdtest.WS, id uuid.UUID) PortalAccess {
	t.Helper()
	var a PortalAccess
	e.Do("GET", "/v1/contacts/"+id.String()+"/portal", ws.Viewer.As(ws), nil).Want(t, 200).JSON(t, &a)
	return a
}

// TestPortalInvite: a member invites a contact, who chooses a password from the email and
// signs in; the member sees each step, and removing access ends it.
func TestPortalInvite(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	path := "/v1/contacts/" + id.String() + "/portal"

	if a := accessOf(t, e, ws, id); a.Status != accessNone || len(a.Brands) != 1 || a.Brands[0].ID != ws.BrandID {
		t.Fatalf("before: %+v", a)
	}
	e.Do("POST", path+"/invite", ws.Viewer.As(ws), map[string]any{}).Want(t, 403)
	var a PortalAccess
	e.Do("POST", path+"/invite", ws.Agent.As(ws), map[string]any{}).Want(t, 200).JSON(t, &a)
	if a.Status != accessInvited || a.InviteExpiresAt == nil || a.InviteExpiresAt.Before(time.Now().Add(6*24*time.Hour)) {
		t.Fatalf("invited: %+v", a)
	}
	subject, token := invitedToken(t, e, email)
	if subject != "You're invited to the customer portal of Customer help" || token == "" {
		t.Fatalf("email %q", subject)
	}
	var stored []byte
	e.Scalar(`SELECT token_hash FROM customer_password_resets WHERE contact_id=$1`, &stored, id)
	if string(stored) == token {
		t.Fatal("invitation token stored in the clear")
	}
	var audited int
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND entity_id=$2 AND action='contact.portal_invited' AND actor_user_id=$3
		AND data->>'brand_id'=$4 AND data::text NOT LIKE '%'||$5||'%'`, &audited, ws.ID, id, ws.Agent.ID, ws.BrandID.String(), token)
	if audited != 1 {
		t.Fatal("invitation not audited, or audited with its link")
	}

	// A link bound to an old address is no longer open.
	e.Exec(`UPDATE customer_password_resets SET email='old-'||email WHERE contact_id=$1`, id)
	if a := accessOf(t, e, ws, id); a.Status != accessNone {
		t.Fatalf("link for another address counted as open: %+v", a)
	}
	e.Exec(`UPDATE customer_password_resets SET email=substr(email, 5) WHERE contact_id=$1`, id)

	reset(t, e, ws, token).Want(t, 204)
	access, _ := signIn(t, e, ws, email)
	if a := accessOf(t, e, ws, id); a.Status != accessActive || !a.Password || a.LastSignInAt == nil || a.InvitedAt != nil {
		t.Fatalf("after sign-in: %+v", a)
	}

	// Removing access signs the customer out, drops the password and closes open links.
	e.Do("POST", path+"/invite", ws.Agent.As(ws), map[string]any{}).Want(t, 200)
	e.Do("DELETE", path, ws.Viewer.As(ws), nil).Want(t, 403)
	e.Do("DELETE", path, ws.Agent.As(ws), nil).Want(t, 204)
	e.Do("GET", "/customer-test", hdtest.Auth{Bearer: access}, nil).Want(t, 401)
	e.Do("POST", base(ws)+"/auth/login", hdtest.Auth{}, body(email)).Want(t, 401)
	_, open := invitedToken(t, e, email)
	reset(t, e, ws, open).Want(t, 400)
	if a := accessOf(t, e, ws, id); a.Status != accessNone || a.Password {
		t.Fatalf("after removal: %+v", a)
	}
	e.Scalar(`SELECT count(*) FROM audit_logs WHERE workspace_id=$1 AND entity_id=$2 AND action='contact.portal_access_removed'`, &audited, ws.ID, id)
	if audited != 1 {
		t.Fatal("removal not audited")
	}
}

// TestPortalInviteRefusals: who cannot be invited, and from where.
func TestPortalInviteRefusals(t *testing.T) {
	e, ws, id, _ := portalEnv(t)
	invite := func(cid uuid.UUID, b map[string]any) *hdtest.Resp {
		return e.Do("POST", "/v1/contacts/"+cid.String()+"/portal/invite", ws.Agent.As(ws), b)
	}
	noEmail, blocked := ids.New(), ids.New()
	e.Exec(`INSERT INTO contacts(id,workspace_id,name) VALUES($1,$2,'Phone only')`, noEmail, ws.ID)
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name,blocked) VALUES($1,$2,$3,'Blocked',true)`, blocked, ws.ID, "blocked-"+blocked.String()+"@example.com")
	if r := invite(noEmail, map[string]any{}).Want(t, 422); !strings.Contains(string(r.Body), "no_email") {
		t.Fatal(string(r.Body))
	}
	if r := invite(blocked, map[string]any{}).Want(t, 422); !strings.Contains(string(r.Body), "contact_blocked") {
		t.Fatal(string(r.Body))
	}
	other := e.NewWorkspace()
	invite(ids.New(), map[string]any{}).Want(t, 404)
	e.Do("GET", "/v1/contacts/"+id.String()+"/portal", other.Owner.As(other), nil).Want(t, 404)

	// Five links an hour per contact, requested or invited.
	for range linksPerContactHour {
		invite(id, map[string]any{}).Want(t, 200)
	}
	invite(id, map[string]any{}).Want(t, 429)

	// A brand that signs in only through its provider has no password to choose.
	e.Exec(`UPDATE brands SET portal_auth_mode='oidc', portal_oidc_issuer='https://idp.example.com', portal_oidc_client_id='portal',
		portal_oidc_client_secret_enc='\x00' WHERE id=$1`, ws.BrandID)
	fresh := ids.New()
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,$3,'Fresh')`, fresh, ws.ID, "fresh-"+fresh.String()+"@example.com")
	if r := invite(fresh, map[string]any{}).Want(t, 422); !strings.Contains(string(r.Body), "password_sign_in_off") {
		t.Fatal(string(r.Body))
	}
	// No help center on: no portal to invite to.
	e.Exec(`UPDATE brands SET portal_auth_mode='local', portal_oidc_issuer='', portal_oidc_client_id='', portal_oidc_client_secret_enc=NULL,
		help_center_enabled=false WHERE id=$1`, ws.BrandID)
	if r := invite(fresh, map[string]any{}).Want(t, 422); !strings.Contains(string(r.Body), "help_center_off") {
		t.Fatal(string(r.Body))
	}
	if r := invite(fresh, map[string]any{"brand_id": other.BrandID}).Want(t, 422); !strings.Contains(string(r.Body), "help_center_off") {
		t.Fatal(string(r.Body))
	}
}

// TestPortalBulkInvite: one request invites who it can and counts who it skipped.
func TestPortalBulkInvite(t *testing.T) {
	e, ws, id, email := portalEnv(t)
	ready, noEmail, blocked, active := ids.New(), ids.New(), ids.New(), id
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name) VALUES($1,$2,$3,'Ready')`, ready, ws.ID, "ready-"+ready.String()+"@example.com")
	e.Exec(`INSERT INTO contacts(id,workspace_id,name) VALUES($1,$2,'Phone only')`, noEmail, ws.ID)
	e.Exec(`INSERT INTO contacts(id,workspace_id,email,name,blocked) VALUES($1,$2,$3,'Blocked',true)`, blocked, ws.ID, "blocked-"+blocked.String()+"@example.com")
	reset(t, e, ws, setupToken(t, e, ws, email)).Want(t, 204)

	var out bulkInviteResult
	e.Do("POST", "/v1/contacts/portal/invite", ws.Agent.As(ws), map[string]any{"ids": []uuid.UUID{ready, ready, noEmail, blocked, active, ids.New()}}).
		Want(t, 200).JSON(t, &out)
	if out.Sent != 1 || out.Skipped[skipNoEmail] != 1 || out.Skipped[skipBlocked] != 1 || out.Skipped[skipActive] != 1 || out.Skipped[skipNotFound] != 1 {
		t.Fatalf("bulk: %+v", out)
	}
	if a := accessOf(t, e, ws, ready); a.Status != accessInvited {
		t.Fatalf("ready: %+v", a)
	}
	too := make([]uuid.UUID, bulkInviteMax+1)
	for i := range too {
		too[i] = ids.New()
	}
	e.Do("POST", "/v1/contacts/portal/invite", ws.Agent.As(ws), map[string]any{"ids": too}).Want(t, 422)
}
