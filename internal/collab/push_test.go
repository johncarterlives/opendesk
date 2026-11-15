package collab

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"github.com/riverqueue/river/rivertype"
)

const (
	testPushTopic   = "projects/od-test/topics/gmail"
	testPushAccount = "gmail-push@od-test.iam.gserviceaccount.com"
)

// pushWorld is a world whose service has Gmail push on, with push tokens it signs itself.
type pushWorld struct {
	*world
	key *rsa.PrivateKey
}

func newPushWorld(t *testing.T) *pushWorld {
	w := newWorld(t)
	d := *w.d
	cfg := *d.Cfg
	cfg.CollabGooglePubSubTopic, cfg.CollabGooglePubSubServiceAccount = testPushTopic, testPushAccount
	d.Cfg = &cfg
	w.s.d = &d
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	w.s.pushKeys = &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}
	return &pushWorld{world: w, key: key}
}

// token is a push token as Pub/Sub signs it, with the claims changed by edit.
func (w *pushWorld) token(edit func(jwt.MapClaims)) string {
	w.t.Helper()
	c := jwt.MapClaims{"iss": googleIssuer, "aud": w.s.d.Cfg.APIURL + gmailPushPath, "email": testPushAccount,
		"email_verified": true, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(), "sub": "1"}
	if edit != nil {
		edit(c)
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodRS256, c).SignedString(w.key)
	if err != nil {
		w.t.Fatal(err)
	}
	return s
}

// push posts a push of address at history with token and answers the status.
func (w *pushWorld) push(token, address, history string) int {
	w.t.Helper()
	data := base64.StdEncoding.EncodeToString([]byte(`{"emailAddress":"` + address + `","historyId":` + history + `}`))
	req := httptest.NewRequest(http.MethodPost, gmailPushPath, strings.NewReader(`{"message":{"data":"`+data+`","messageId":"1"},"subscription":"s"}`))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	w.s.gmailPush(rec, req)
	return rec.Code
}

func (w *pushWorld) queued(a *accountRow) bool {
	return w.count(`SELECT count(*) FROM river_job WHERE kind = 'collab.sync_account' AND args->>'account_id' = $1`, a.ID.String()) > 0
}

func (w *pushWorld) clearJobs(a *accountRow) {
	mustExec(w.t, w.d, `DELETE FROM river_job WHERE kind = 'collab.sync_account' AND args->>'account_id' = $1`, a.ID.String())
}

// TestGmailPushQueuesTheSync: a verified push of a change the account has not synced queues
// its sync; others are answered and dropped.
func TestGmailPushQueuesTheSync(t *testing.T) {
	w := newPushWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	other := w.account(w.agent2, ProviderGoogle, VisibilityPrivate, Audience{})
	mustExec(t, w.d, `UPDATE collab_accounts SET sync_state = '{"history_id":"100"}' WHERE id = ANY(ARRAY[$1, $2]::uuid[])`, a.ID, other.ID)
	w.clearJobs(a)
	w.clearJobs(other)

	// Only Pub/Sub's token for this URL, as the configured service account, is taken.
	for name, edit := range map[string]func(jwt.MapClaims){
		"another audience":        func(c jwt.MapClaims) { c["aud"] = "https://elsewhere.test/push" },
		"another service account": func(c jwt.MapClaims) { c["email"] = "someone@od-test.iam.gserviceaccount.com" },
		"an unverified email":     func(c jwt.MapClaims) { c["email_verified"] = false },
		"another issuer":          func(c jwt.MapClaims) { c["iss"] = "https://issuer.test" },
		"an expired token":        func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() },
	} {
		if st := w.push(w.token(edit), a.Email, "120"); st != http.StatusUnauthorized {
			t.Fatalf("%s: %d", name, st)
		}
	}
	if st := w.push("", a.Email, "120"); st != http.StatusUnauthorized {
		t.Fatalf("no token: %d", st)
	}
	if w.queued(a) {
		t.Fatal("a refused push queued a sync")
	}

	// A change already synced queues nothing.
	if st := w.push(w.token(nil), a.Email, "90"); st != http.StatusNoContent || w.queued(a) {
		t.Fatalf("old change: %d queued %v", st, w.queued(a))
	}
	// A new one queues the sync of that mailbox alone, whatever the address's case.
	if st := w.push(w.token(nil), strings.ToUpper(a.Email), "120"); st != http.StatusNoContent || !w.queued(a) || w.queued(other) {
		t.Fatalf("new change: %d queued %v other %v", st, w.queued(a), w.queued(other))
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id = $1 AND gmail_push_history = 120`, a.ID); n != 1 {
		t.Fatal("pushed history not kept")
	}
	// The newest push is kept: an older one arriving late does not lower it.
	if st := w.push(w.token(nil), a.Email, "110"); st != http.StatusNoContent {
		t.Fatalf("late push: %d", st)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id = $1 AND gmail_push_history = 120`, a.ID); n != 1 {
		t.Fatal("a late push lowered the pushed history")
	}
	// Unknown mailboxes and unreadable data are dropped with 204, so Pub/Sub stops sending them.
	if st := w.push(w.token(nil), "nobody@example.com", "120"); st != http.StatusNoContent {
		t.Fatalf("unknown mailbox: %d", st)
	}
	if st := w.push(w.token(nil), a.Email, `"not-a-number"`); st != http.StatusNoContent {
		t.Fatalf("bad history: %d", st)
	}

	// An account in its backoff, waiting for a reconnect or in a suspended workspace waits.
	w.clearJobs(a)
	mustExec(t, w.d, `UPDATE collab_accounts SET next_sync_at = now() + interval '5 minutes' WHERE id = $1`, a.ID)
	if w.push(w.token(nil), a.Email, "130"); w.queued(a) {
		t.Fatal("an account in its backoff was queued")
	}
	mustExec(t, w.d, `UPDATE collab_accounts SET next_sync_at = NULL, reconnect = true WHERE id = $1`, a.ID)
	if w.push(w.token(nil), a.Email, "140"); w.queued(a) {
		t.Fatal("an account waiting for a reconnect was queued")
	}
	mustExec(t, w.d, `UPDATE collab_accounts SET reconnect = false WHERE id = $1`, a.ID)
	mustExec(t, w.d, `UPDATE workspaces SET suspended_at = now() WHERE id = $1`, w.wid)
	if w.push(w.token(nil), a.Email, "150"); w.queued(a) {
		t.Fatal("a suspended workspace's account was queued")
	}
}

// TestGmailPushOff: without the topic and service account the route does not exist.
func TestGmailPushOff(t *testing.T) {
	w := newWorld(t)
	req := httptest.NewRequest(http.MethodPost, gmailPushPath, strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	w.s.gmailPush(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("push off: %d", rec.Code)
	}
}

// TestGmailWatch: a sync watches the account on the topic once a day, at once when the topic
// changes, and an hour after Gmail refused, never failing the sync.
func TestGmailWatch(t *testing.T) {
	w := newPushWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	watchAt := func() time.Time {
		var at time.Time
		if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT gmail_watch_at FROM collab_accounts WHERE id = $1`, a.ID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	sync := func() {
		t.Helper()
		if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
			t.Fatal(err)
		}
	}

	sync()
	if len(g.watches) != 1 || g.watches[0] != testPushTopic || time.Until(watchAt()) < 23*time.Hour {
		t.Fatalf("first sync: watches %v next %v", g.watches, watchAt())
	}
	sync()
	if len(g.watches) != 1 {
		t.Fatalf("watched again within the day: %v", g.watches)
	}
	// A new topic is watched at once.
	cfg := *w.s.d.Cfg
	cfg.CollabGooglePubSubTopic = "projects/od-test/topics/gmail-2"
	w.s.d.Cfg = &cfg
	sync()
	if len(g.watches) != 2 || g.watches[1] != cfg.CollabGooglePubSubTopic {
		t.Fatalf("new topic: %v", g.watches)
	}
	// Gmail refusing the watch leaves the sync alone and tries again in an hour.
	mustExec(t, w.d, `UPDATE collab_accounts SET gmail_watch_at = now() - interval '1 minute' WHERE id = $1`, a.ID)
	g.watchStatus = http.StatusForbidden
	sync()
	if a = w.reload(a); a.Status != "active" {
		t.Fatalf("a refused watch failed the sync: %s %q", a.Status, a.LastError)
	}
	if left := time.Until(watchAt()); left < 50*time.Minute || left > 70*time.Minute {
		t.Fatalf("retry after a refusal in %v", left)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id = $1 AND gmail_watch_topic = $2`, a.ID, cfg.CollabGooglePubSubTopic); n != 1 {
		t.Fatal("a refused watch changed the watched topic")
	}
}

// TestGmailPushDuringAPass: a push the pass did not reach asks for another pass soon, and
// only after a pass that moved on.
func TestGmailPushDuringAPass(t *testing.T) {
	w := newPushWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	mustExec(t, w.d, `UPDATE collab_accounts SET sync_state = '{"history_id":"100"}', gmail_push_history = 105 WHERE id = $1`, a.ID)
	snoozed := func(before string) bool {
		var snooze *rivertype.JobSnoozeError
		return errors.As(w.s.pushedDuring(w.ctx, a.ID, before), &snooze)
	}
	if !snoozed("90") {
		t.Fatal("a push the pass did not reach asked for no pass")
	}
	if snoozed("100") {
		t.Fatal("a pass that did not move on asked for another")
	}
	if w.s.storedGmailHistory(w.ctx, a.ID) != "100" {
		t.Fatalf("stored history: %q", w.s.storedGmailHistory(w.ctx, a.ID))
	}
	mustExec(t, w.d, `UPDATE collab_accounts SET gmail_push_history = 100 WHERE id = $1`, a.ID)
	if snoozed("90") {
		t.Fatal("a push the pass reached asked for another")
	}
	// Push off, nothing follows.
	if newWorld(t).s.storedGmailHistory(w.ctx, a.ID) != "" {
		t.Fatal("stored history read with push off")
	}
}
