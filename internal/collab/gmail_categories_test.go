package collab

import (
	"fmt"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/useopendesk/opendesk/internal/jobs"
)

func (w *world) gmailMode(a *accountRow, mode string) MailAccount {
	w.t.Helper()
	var out MailAccount
	var prob map[string]any
	body := map[string]any{"mode": mode}
	srv := w.api(w.agent)
	if code := doJSON(w.t, http.MethodPut, srv.URL+"/v1/collab/accounts/"+a.ID.String()+"/categories", body, &out); code != 200 {
		doJSON(w.t, http.MethodPut, srv.URL+"/v1/collab/accounts/"+a.ID.String()+"/categories", body, &prob)
		w.t.Fatalf("mode %s: %d %+v", mode, code, prob)
	}
	return out
}

func (w *world) categoryMove(a *accountRow, t *threadRow, key string) jobs.CollabApplyArgs {
	w.t.Helper()
	if code := doJSON(w.t, http.MethodPost, w.api(w.agent).URL+"/v1/collab/threads/actions", map[string]any{
		"thread_ids": []uuid.UUID{t.ID}, "action": "categorize", "category": key}, nil); code != 200 {
		w.t.Fatalf("move: %d", code)
	}
	var id uuid.UUID
	if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT id FROM collab_category_intents WHERE thread_id=$1`, t.ID).Scan(&id); err != nil {
		w.t.Fatal(err)
	}
	return jobs.CollabApplyArgs{WorkspaceID: a.WorkspaceID, AccountID: a.ID, Action: ActionCategorize, CategoryIntentID: &id}
}

func (w *world) deliverCategory(args jobs.CollabApplyArgs, attempt int) error {
	return w.s.applyRemote(w.ctx, &river.Job[jobs.CollabApplyArgs]{JobRow: &rivertype.JobRow{Attempt: attempt, MaxAttempts: 8}, Args: args})
}

func (w *world) wantCategory(a *accountRow, remote, key string) {
	w.t.Helper()
	row := w.threadByRemote(a, remote)
	if row.Category == nil || *row.Category != key {
		w.t.Fatalf("%s category: %v want %s", remote, row.Category, key)
	}
}

func gmailCategoryWorld(t *testing.T) (*world, *fakeGmail, *accountRow) {
	t.Helper()
	w := newWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	g.add("m1", "t1", []string{"INBOX", "UNREAD", "Label_1", "CATEGORY_UPDATES"}, testMail{from: "alice@example.com", to: a.Email, msgID: "m1@example.com", subject: "Hello"})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	return w, g, w.reload(a)
}

func TestGmailCategoriesRoundTrip(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	out := w.gmailMode(a, modeGmail)
	if out.Categories.Engine != modeGmail || out.Categories.AI || !out.Categories.Enabled || !slices.Equal(categoryKeys(out.Categories), []string{"primary", "social", "promotions", "updates", "forums"}) {
		t.Fatalf("catalog: %+v", out.Categories)
	}
	w.wantCategory(a, "t1", "updates")
	// A message outside the stored subset is nevertheless changed at the provider.
	g.add("outside", "t1", []string{"TRASH", "Label_1", "CATEGORY_SOCIAL"}, testMail{date: time.Now().Add(-365 * 24 * time.Hour), msgID: "old@example.com"})
	g.add("draft", "t1", []string{"DRAFT"}, testMail{msgID: "draft@example.com"})
	for _, key := range []string{"forums", "primary", "social", "promotions", "updates"} {
		args := w.categoryMove(a, w.threadByRemote(a, "t1"), key)
		w.wantCategory(a, "t1", key)
		if err := w.deliverCategory(args, 1); err != nil {
			t.Fatal(err)
		}
		w.wantCategory(a, "t1", key)
		for _, id := range []string{"m1", "outside"} {
			g.mu.Lock()
			m := g.msgs[id]
			ob, err := gmailObservation(&gmailMessage{HistoryID: "100", LabelIDs: m.labels})
			g.mu.Unlock()
			if err != nil || ob.Mask != gmailCategoryBit(key) {
				t.Fatalf("remote %s: %+v %v", id, ob, err)
			}
		}
		if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE thread_id=$1 AND state='applied'`, w.threadByRemote(a, "t1").ID); n != 1 {
			t.Fatal("not acknowledged")
		}
	}
	g.mu.Lock()
	if !slices.Contains(g.msgs["m1"].labels, "UNREAD") || !slices.Contains(g.msgs["m1"].labels, "Label_1") || !slices.Contains(g.msgs["outside"].labels, "TRASH") {
		t.Error("unrelated labels changed")
	}
	if !slices.Equal(g.msgs["draft"].labels, []string{"DRAFT"}) {
		t.Error("draft labels changed")
	}
	if len(g.categoryModify) != 5 {
		t.Errorf("mutations %d", len(g.categoryModify))
	}
	g.msgs["m1"].labels = []string{"INBOX", "UNREAD", "Label_1", "CATEGORY_FORUMS"}
	g.mu.Unlock()
	g.record("labelsAdded", "m1")
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
	// There is no persistent override: a later arrival follows Gmail.
	g.add("new", "t1", []string{"INBOX", "CATEGORY_SOCIAL"}, testMail{from: "alice@example.com", to: a.Email, msgID: "new@example.com", date: time.Now()})
	g.record("messagesAdded", "new")
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "social")
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id=$1 AND NOT draft`, a.ID); n != 2 {
		t.Fatalf("unexpected body imports %d", n)
	}
}

func TestGmailCategoriesStaleActionsAndModes(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	first := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	second := w.categoryMove(a, w.threadByRemote(a, "t1"), "social")
	if err := w.deliverCategory(second, 1); err != nil {
		t.Fatal(err)
	}
	if err := w.deliverCategory(first, 1); err != nil {
		t.Fatal(err)
	}
	if err := w.deliverCategory(second, 2); err != nil {
		t.Fatal(err)
	}
	if len(g.categoryModify) != 1 {
		t.Fatalf("stale or duplicate mutations %d", len(g.categoryModify))
	}
	w.wantCategory(a, "t1", "social")
	before := w.reload(a)
	third := w.categoryMove(a, w.threadByRemote(a, "t1"), "promotions")
	w.gmailMode(a, modeOff)
	w.gmailMode(a, modeGmail)
	if err := w.deliverCategory(third, 1); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "social")
	if len(g.categoryModify) != 1 {
		t.Fatal("old epoch was delivered")
	}
	// A late AI result from an earlier epoch cannot commit, even after returning local.
	w.gmailMode(a, modeCustom)
	tid := w.threadByRemote(a, "t1").ID
	mustExec(t, w.d, `UPDATE collab_threads SET category_pending=true,category='primary' WHERE id=$1`, tid)
	if err := w.s.storeSorted(w.ctx, before, []sortResult{{ThreadID: tid, Category: "promotions", Source: sortedByAI}}); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "primary")
}

func TestGmailCategoriesFailureAndReconnect(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	args := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	g.categoryStatus = 400
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "updates")
	if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE id=$1 AND state='failed'`, *args.CategoryIntentID); n != 1 {
		t.Fatal("permanent error not persisted")
	}
	g.categoryStatus = 429
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "social")
	if err := w.deliverCategory(args, 1); err == nil {
		t.Fatal("transient failure lost")
	}
	w.wantCategory(a, "t1", "social")
	g.categoryStatus = 0
	if err := w.deliverCategory(args, 2); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "social")
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	mustExec(t, w.d, `UPDATE collab_accounts SET reconnect=true WHERE id=$1`, a.ID)
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE id=$1 AND state='blocked'`, *args.CategoryIntentID); n != 1 {
		t.Fatal("reconnect discarded work")
	}
	mustExec(t, w.d, `UPDATE collab_accounts SET reconnect=false WHERE id=$1`, a.ID)
	if err := w.deliverCategory(args, 2); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
}

func TestGmailCategoriesObservations(t *testing.T) {
	w, _, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	a = w.reload(a)
	p, err := w.s.newPass(w.ctx, w.d.DB.Pool, a)
	if err != nil {
		t.Fatal(err)
	}
	set := func(version string, mask int) {
		t.Helper()
		if err := p.batch(w.ctx, func(tx pgx.Tx) error {
			m, err := p.lookup(w.ctx, tx, "m1")
			if err != nil {
				return err
			}
			st := state{Unread: m.Unread, Starred: m.Starred, Draft: m.Draft, FolderIDs: m.FolderIDs, Gmail: &gmailCategoryObservation{Mask: mask, Version: version}}
			return p.update(w.ctx, tx, m, st)
		}); err != nil {
			t.Fatal(err)
		}
	}
	set("1000000000000000000000", 16)
	w.wantCategory(a, "t1", "forums")
	set("999999999999999999999", 4)
	w.wantCategory(a, "t1", "forums")
	set("1000000000000000000001", 0)
	w.wantCategory(a, "t1", "primary")
	set("1000000000000000000002", 2|16)
	w.wantCategory(a, "t1", "social")
	set("1000000000000000000003", 1|16)
	w.wantCategory(a, "t1", "primary")
}

func TestGmailCategoriesValidation(t *testing.T) {
	w, _, a := gmailCategoryWorld(t)
	srv := w.api(w.agent)
	path := srv.URL + "/v1/collab/accounts/" + a.ID.String() + "/categories"
	for _, body := range []map[string]any{{"mode": "gmail", "ai": true}, {"mode": "gmail", "categories": []any{}}} {
		if code := doJSON(t, http.MethodPut, path, body, nil); code != 422 {
			t.Fatalf("incompatible: %d", code)
		}
	}
	w.gmailMode(a, modeGmail)
	if code := doJSON(t, http.MethodPost, srv.URL+"/v1/collab/accounts/"+a.ID.String()+"/category-rules", map[string]any{"sender": "alice@example.com", "category": "forums"}, nil); code != 422 {
		t.Fatalf("rule %d", code)
	}
	if code := doJSON(t, http.MethodPut, w.api(w.owner).URL+"/v1/collab/accounts/"+a.ID.String()+"/categories", map[string]any{"mode": "gmail"}, nil); code != 404 {
		t.Fatalf("private account leaked: %d", code)
	}
	for _, provider := range []string{ProviderMicrosoft, ProviderIMAP} {
		b := w.account(w.agent, provider, VisibilityPrivate, Audience{})
		if code := doJSON(t, http.MethodPut, srv.URL+"/v1/collab/accounts/"+b.ID.String()+"/categories", map[string]any{"mode": "gmail"}, nil); code != 422 {
			t.Fatalf("provider %s: %d", provider, code)
		}
	}
	// Mixed-account actions validate every account before admitting a single intent.
	b := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	inbox := w.folder(b, RoleInbox)
	tid, _ := w.seedThread(b, "Other", inbox)
	code := doJSON(t, http.MethodPost, srv.URL+"/v1/collab/threads/actions", map[string]any{"thread_ids": []uuid.UUID{w.threadByRemote(a, "t1").ID, tid}, "action": "categorize", "category": "forums"}, nil)
	if code != 422 {
		t.Fatalf("cross account validation %d", code)
	}
	if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE account_id=$1`, a.ID); n != 0 {
		t.Fatal("partial admission")
	}
}

// Seed the pre-feature cache, including mail older than every ordinary sync window.
func legacyGmailCategoryWorld(t *testing.T, n int) (*world, *fakeGmail, *accountRow) {
	t.Helper()
	w := newWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	for j := 0; j < n; j++ {
		id := fmt.Sprintf("old-%03d", j)
		labels := []string{"CATEGORY_UPDATES"}
		if j%3 == 0 {
			labels = append(labels, "TRASH")
		} else if j%3 == 1 {
			labels = append(labels, "SPAM")
		}
		g.add(id, "t-"+id, labels, testMail{from: "alice@example.com", to: a.Email, msgID: id + "@example.com", date: time.Now().Add(-400 * 24 * time.Hour)})
	}
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	p, err := w.s.newPass(w.ctx, w.d.DB.Pool, w.reload(a))
	if err != nil {
		t.Fatal(err)
	}
	p.quiet = true
	if err := p.batch(w.ctx, func(tx pgx.Tx) error {
		for _, id := range g.order {
			m := g.msgs[id]
			if _, err := p.insert(w.ctx, tx, &newMessage{RemoteID: id, ThreadRemoteID: m.thread, Raw: m.raw, Date: m.date, State: p.gmailState(m.labels)}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return w, g, w.reload(a)
}

func TestGmailCategoriesActivationResumesAndReplays(t *testing.T) {
	w, g, a := legacyGmailCategoryWorld(t, 105)
	baseline := historyOf(a)
	w.gmailMode(a, modeGmail)
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id=$1 AND gmail_category_mask IS NOT NULL`, a.ID); n != 100 {
		t.Fatalf("first page %d", n)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id=$1 AND category_refresh->>'cursor' IS NOT NULL`, a.ID); n != 1 {
		t.Fatal("cursor not durable")
	}
	if historyOf(w.reload(a)) != baseline {
		t.Fatal("baseline promoted before sweep completed")
	}
	var first string
	if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT remote_id FROM collab_messages WHERE account_id=$1 ORDER BY id LIMIT 1`, a.ID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.msgs[first].labels = []string{"CATEGORY_FORUMS", "TRASH"}
	g.mu.Unlock()
	g.record("labelsAdded", first)
	g.add("new", "new-thread", []string{"INBOX", "CATEGORY_SOCIAL"}, testMail{from: "new@example.com", to: a.Email, msgID: "new@example.com", date: time.Now()})
	g.record("messagesAdded", "new")
	// Fail the next metadata page. The cursor and old live baseline survive.
	g.failMinimalAfter = g.minimalGets
	if err := w.s.runSync(w.ctx, w.reload(a)); err == nil {
		t.Fatal("expected provider failure")
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id=$1 AND gmail_category_mask IS NOT NULL`, a.ID); n != 100 {
		t.Fatalf("failed page committed %d", n)
	}
	if historyOf(w.reload(a)) != baseline {
		t.Fatal("failure advanced baseline")
	}
	g.failMinimalAfter = 0
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t-"+first, "forums")
	w.wantCategory(a, "new-thread", "social")
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id=$1 AND category_refresh IS NOT NULL`, a.ID); n != 0 {
		t.Fatal("refresh not complete")
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id=$1 AND gmail_category_mask IS NOT NULL`, a.ID); n != 106 {
		t.Fatalf("observation coverage %d", n)
	}
	if len(g.categoryModify) != 0 {
		t.Fatal("activation wrote local classifications remotely")
	}
}

func TestGmailCategoriesExpiredHistoryRefreshesAllStored(t *testing.T) {
	w, g, a := legacyGmailCategoryWorld(t, 3)
	w.gmailMode(a, modeGmail)
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.msgs["old-000"].labels = []string{"TRASH", "CATEGORY_FORUMS"}
	g.history++
	g.expireBefore = g.history
	g.mu.Unlock()
	before := historyOf(w.reload(a))
	// The live cursor expires; recovery persists its start before reading any old mail.
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	if historyOf(w.reload(a)) != before {
		t.Fatal("expired cursor replaced without refresh")
	}
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t-old-000", "forums")
	if n := w.messages(a); n != 3 {
		t.Fatalf("recovery imported extra bodies %d", n)
	}
	if historyOf(w.reload(a)) == before {
		t.Fatal("recovery did not advance after replay")
	}
	// Expiration during a sweep resets the durable keyset and captures a fresh baseline.
	mustExec(t, w.d, `UPDATE collab_accounts SET category_refresh='{}' WHERE id=$1`, a.ID)
	g.mu.Lock()
	g.history++
	g.mu.Unlock()
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
}

func TestGmailCategoriesEnabledBeforeFirstSync(t *testing.T) {
	w := newWorld(t)
	g := newFakeGmail(t)
	w.useGmail(g)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	g.add("first", "first-thread", []string{"INBOX", "CATEGORY_FORUMS"}, testMail{from: "a@example.com", to: a.Email, msgID: "first@example.com"})
	w.gmailMode(a, modeGmail)
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "first-thread", "forums")
}

func TestGmailCategoriesWorkspaceLockAndDormantSettings(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	agent := w.api(w.agent)
	owner := w.api(w.owner)
	path := "/v1/collab/accounts/" + a.ID.String() + "/categories"
	custom := []MailCategory{{Key: "primary", Name: "Primary", Color: "gray"}, {Key: "projects", Name: "Projects", Color: "gray"}}
	if code := doJSON(t, http.MethodPut, agent.URL+path, map[string]any{"mode": "custom", "categories": custom, "ai": true}, nil); code != 200 {
		t.Fatal(code)
	}
	out := w.gmailMode(a, modeGmail)
	if !slices.Equal(out.Categories.Own, custom) {
		t.Fatalf("dormant custom lost %+v", out.Categories.Own)
	}
	args := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	if code := doJSON(t, http.MethodPut, owner.URL+"/v1/collab/categories/workspace", map[string]any{"enabled": true, "locked": true}, nil); code != 200 {
		t.Fatal(code)
	}
	account, err := w.s.accountOut(w.ctx, w.d.DB.Pool, w.agent, w.reload(a))
	if err != nil {
		t.Fatal(err)
	}
	if account.Categories.Mode != modeGmail || account.Categories.Engine != "local" {
		t.Fatalf("suppressed: %+v", account.Categories)
	}
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
	if len(g.categoryModify) != 0 {
		t.Fatal("suppressed intent delivered")
	}
	if code := doJSON(t, http.MethodPut, owner.URL+"/v1/collab/categories/workspace", map[string]any{"enabled": true, "locked": false}, nil); code != 200 {
		t.Fatal(code)
	}
	account, err = w.s.accountOut(w.ctx, w.d.DB.Pool, w.agent, w.reload(a))
	if err != nil {
		t.Fatal(err)
	}
	if account.Categories.Engine != modeGmail {
		t.Fatal("override not restored")
	}
	out = w.gmailMode(a, modeCustom)
	if out.Categories.Engine != "local" || !out.Categories.AI || !slices.Equal(out.Categories.Own, custom) {
		t.Fatalf("restore %+v", out.Categories)
	}
}

func TestGmailCategoriesInFlightSupersession(t *testing.T) {
	for _, status := range []int{0, 429} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			w, g, a := gmailCategoryWorld(t)
			w.gmailMode(a, modeGmail)
			first := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
			entered, release := make(chan struct{}), make(chan struct{})
			var enterOnce, releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			defer unblock()
			g.hookMu.Lock()
			g.beforeCategoryModify = func() { enterOnce.Do(func() { close(entered); <-release }) }
			g.hookMu.Unlock()
			g.categoryStatus = status
			done := make(chan error, 1)
			go func() { done <- w.deliverCategory(first, 1) }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("request never entered")
			}
			second := w.categoryMove(a, w.threadByRemote(a, "t1"), "social")
			if err := w.deliverCategory(second, 1); err == nil {
				t.Fatal("parallel delivery bypassed account lock")
			}
			unblock()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("delivery did not finish")
			}
			w.wantCategory(a, "t1", "social")
			g.mu.Lock()
			calls := len(g.categoryModify)
			g.categoryStatus = 0
			g.mu.Unlock()
			if calls != 1 {
				t.Fatalf("superseded operation retried %d times", calls)
			}
			if err := w.deliverCategory(second, 2); err != nil {
				t.Fatal(err)
			}
			if err := w.deliverCategory(first, 2); err != nil {
				t.Fatal(err)
			}
			w.wantCategory(a, "t1", "social")
		})
	}
}

func TestGmailCategoriesCrashReadbackAndRecovery(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	args := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	// Crash after provider success but before persisting confirming.
	gp := &gmailProvider{s: w.s, a: w.reload(a)}
	if err := gp.Apply(w.ctx, ApplyOp{category: &gmailCategoryChange{Thread: "t1", Key: "forums"}}); err != nil {
		t.Fatal(err)
	}
	if err := w.deliverCategory(args, 2); err != nil {
		t.Fatal(err)
	}
	if len(g.categoryModify) != 1 {
		t.Fatal("successful uncertain write was repeated")
	}
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "promotions")
	// Crash after confirming: a concurrent Gmail edit wins the resumed readback.
	mustExec(t, w.d, `UPDATE collab_category_intents SET state='confirming' WHERE id=$1`, *args.CategoryIntentID)
	g.mu.Lock()
	g.msgs["m1"].labels = []string{"INBOX", "CATEGORY_SOCIAL"}
	g.history++
	g.mu.Unlock()
	if err := w.deliverCategory(args, 2); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "social")
	if len(g.categoryModify) != 1 {
		t.Fatal("confirming write replayed")
	}
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "updates")
	// A lost/exhausted wakeup is recreated; a live retry is left alone.
	mustExec(t, w.d, `DELETE FROM river_job WHERE kind='collab.apply' AND args->>'category_intent_id'=$1`, args.CategoryIntentID.String())
	mustExec(t, w.d, `UPDATE collab_category_intents SET updated_at=now()-interval '5 minutes' WHERE id=$1`, *args.CategoryIntentID)
	if err := w.s.recoverCategoryIntents(w.ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.s.recoverCategoryIntents(w.ctx); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM river_job WHERE kind='collab.apply' AND args->>'category_intent_id'=$1`, args.CategoryIntentID.String()); n != 1 {
		t.Fatalf("wakeups %d", n)
	}
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
}

func TestGmailCategoriesHistoryImportKnownAndReplies(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	// No history record: importing already-stored IDs must still read current metadata.
	g.mu.Lock()
	g.msgs["m1"].labels = []string{"INBOX", "CATEGORY_FORUMS"}
	g.history++
	g.mu.Unlock()
	if code := doJSON(t, http.MethodPut, w.api(w.agent).URL+"/v1/collab/accounts/"+a.ID.String()+"/history", map[string]any{}, nil); code != 200 {
		t.Fatal(code)
	}
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
	trow := w.threadByRemote(a, "t1")
	// Reply-to-Primary and sender rules remain dormant.
	if _, err := w.s.storeSent(w.ctx, w.reload(a), testMail{from: a.Email, to: "alice@example.com", msgID: "reply@example.com"}.raw(), SentRef{RemoteID: "reply", ThreadRemoteID: "t1", FolderRemoteIDs: []string{"SENT"}}, w.agent.UserID, &trow.ID); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
	if err := w.s.categorize(w.ctx, a.ID, 1); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
}

func TestGmailCategoriesSweepBaselineExpires(t *testing.T) {
	w, g, a := legacyGmailCategoryWorld(t, 105)
	w.gmailMode(a, modeGmail)
	before := historyOf(w.reload(a))
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.history++
	g.expireBefore = g.history
	g.mu.Unlock()
	// The second sweep page succeeds, but replay's baseline expired.
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id=$1 AND category_refresh->>'baseline'=''`, a.ID); n != 1 {
		t.Fatal("expired sweep was marked ready")
	}
	if historyOf(w.reload(a)) != before {
		t.Fatal("expired baseline promoted")
	}
	// New baseline, full sweep again, then replay and commit.
	for j := 0; j < 2; j++ {
		if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
			t.Fatal(err)
		}
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id=$1 AND category_refresh IS NOT NULL`, a.ID); n != 0 {
		t.Fatal("new sweep never completed")
	}
}

func TestGmailCategoriesDeletedMessagesAndThread(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	g.add("later", "t1", []string{"INBOX", "CATEGORY_FORUMS"}, testMail{from: "a@example.com", to: a.Email, msgID: "later@example.com", date: time.Now()})
	g.record("messagesAdded", "later")
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
	g.mu.Lock()
	delete(g.msgs, "later")
	g.mu.Unlock()
	g.record("messagesDeleted", "later")
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "updates")
	args := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	g.mu.Lock()
	delete(g.msgs, "m1")
	g.mu.Unlock()
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE account_id=$1`, a.ID); n != 0 {
		t.Fatal("gone thread retained")
	}
	if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE account_id=$1`, a.ID); n != 0 {
		t.Fatal("gone thread intent retained")
	}
	if err := w.deliverCategory(args, 2); err != nil {
		t.Fatal(err)
	}
}

func TestGmailCategoriesLiveMailDuringSweep(t *testing.T) {
	w, g, a := legacyGmailCategoryWorld(t, 205)
	w.gmailMode(a, modeGmail)
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	g.add("fresh", "fresh-thread", []string{"INBOX", "CATEGORY_SOCIAL"}, testMail{from: "a@example.com", to: a.Email, msgID: "fresh@example.com"})
	g.record("messagesAdded", "fresh")
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id=$1 AND category_refresh IS NOT NULL`, a.ID); n != 1 {
		t.Fatal("sweep should still be running")
	}
	w.wantCategory(a, "fresh-thread", "social")
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "fresh-thread", "social")
}

func TestGmailCategoriesActivationReplaysUnimportedOldArrival(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	// A new history arrival can have an internal date outside the bounded window.
	g.add("late-old", "late-old-thread", []string{"CATEGORY_FORUMS"}, testMail{from: "a@example.com", to: a.Email, msgID: "late-old@example.com", date: time.Now().Add(-500 * 24 * time.Hour)})
	g.record("messagesAdded", "late-old")
	w.gmailMode(a, modeGmail)
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "late-old-thread", "forums")
}

func TestGmailCategoriesReadbackFailureAndExhaustion(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	args := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	g.failThreadAfter = 2
	if err := w.deliverCategory(args, 1); err == nil {
		t.Fatal("failed readback reported complete")
	}
	if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE id=$1 AND state='confirming'`, *args.CategoryIntentID); n != 1 {
		t.Fatal("readback not durable")
	}
	g.mu.Lock()
	g.failThreadAfter = 0
	g.msgs["m1"].labels = []string{"INBOX", "CATEGORY_SOCIAL"}
	g.history++
	g.mu.Unlock()
	if err := w.deliverCategory(args, 2); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "social")
	if len(g.categoryModify) != 1 {
		t.Fatal("readback retried mutation")
	}
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "promotions")
	g.categoryStatus = 503
	if err := w.deliverCategory(args, 8); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "social")
	if n := w.count(`SELECT count(*) FROM collab_category_intents WHERE id=$1 AND state='failed'`, *args.CategoryIntentID); n != 1 {
		t.Fatal("exhausted move retained overlay")
	}
	g.categoryStatus = 0
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	g.failThreadAfter = g.threadGets + 2
	if err := w.deliverCategory(args, 8); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_accounts WHERE id=$1 AND category_refresh IS NOT NULL`, a.ID); n != 1 {
		t.Fatal("uncertain readback lost reconciliation")
	}
	g.failThreadAfter = 0
	if err := w.s.runSync(w.ctx, w.reload(a)); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
}

func TestGmailCategoriesProjectionUnknownDraftAndArchive(t *testing.T) {
	w, _, a := gmailCategoryWorld(t)
	w.gmailMode(a, modeGmail)
	p, err := w.s.newPass(w.ctx, w.d.DB.Pool, w.reload(a))
	if err != nil {
		t.Fatal(err)
	}
	var newer uuid.UUID
	if err := p.batch(w.ctx, func(tx pgx.Tx) error {
		var err error
		newer, err = p.insert(w.ctx, tx, &newMessage{RemoteID: "unknown", ThreadRemoteID: "t1", Raw: testMail{from: "a@example.com", to: a.Email, msgID: "unknown@example.com"}.raw(), Date: time.Now(), State: p.gmailState([]string{"INBOX"})})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "primary") // never prefer older known evidence over newer unknown mail
	if err := p.batch(w.ctx, func(tx pgx.Tx) error {
		m, err := p.lookup(w.ctx, tx, "unknown")
		if err != nil {
			return err
		}
		st := p.gmailState([]string{"INBOX"})
		st.Gmail = &gmailCategoryObservation{Mask: 16, Version: "200"}
		if err := p.update(w.ctx, tx, m, st); err != nil {
			return err
		}
		st = p.gmailState([]string{"DRAFT", "INBOX"})
		st.Gmail = &gmailCategoryObservation{Mask: 4, Version: "201"}
		_, err = p.insert(w.ctx, tx, &newMessage{RemoteID: "draft", ThreadRemoteID: "t1", Raw: testMail{from: a.Email, to: "a@example.com", msgID: "draft@example.com"}.raw(), Date: time.Now().Add(time.Hour), State: st})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums")
	if err := w.d.DB.Tx(w.ctx, func(tx pgx.Tx) error {
		return w.s.applyLocal(w.ctx, tx, w.reload(a), []uuid.UUID{w.threadByRemote(a, "t1").ID}, ActionArchive, nil)
	}); err != nil {
		t.Fatal(err)
	}
	if err := p.batch(w.ctx, func(tx pgx.Tx) error {
		_, err := p.insert(w.ctx, tx, &newMessage{RemoteID: "reply", ThreadRemoteID: "t1", Raw: testMail{from: a.Email, to: "a@example.com", msgID: "reply@example.com"}.raw(), Date: time.Now().Add(2 * time.Hour), State: p.gmailState([]string{"SENT"})})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	w.wantCategory(a, "t1", "forums") // an archived conversation keeps its received category after a reply
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE id=$1 AND gmail_category_mask=16`, newer); n != 1 {
		t.Fatal("observation changed on archive")
	}
}

func TestGmailCategoriesDeliveryStatus(t *testing.T) {
	w, g, a := gmailCategoryWorld(t)
	assertStatus := func(want string) {
		t.Helper()
		out, err := w.s.accountOut(w.ctx, w.d.DB.Pool, w.agent, w.reload(a))
		if err != nil || out.Categories.SyncStatus != want {
			t.Fatalf("sync status %q, want %q: %v", out.Categories.SyncStatus, want, err)
		}
	}
	w.gmailMode(a, modeGmail)
	assertStatus("refreshing")
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	assertStatus("ready")
	args := w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	assertStatus("pending")
	g.categoryStatus = http.StatusForbidden
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
	assertStatus("failed")
	g.categoryStatus = 0
	args = w.categoryMove(a, w.threadByRemote(a, "t1"), "forums")
	if err := w.deliverCategory(args, 1); err != nil {
		t.Fatal(err)
	}
	assertStatus("ready")
}
