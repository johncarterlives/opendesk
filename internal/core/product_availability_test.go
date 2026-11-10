package core

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/plan"
)

// The setup checklist follows the products (contracts/api.md "Onboarding").
func TestOnboardingFollowsProducts(t *testing.T) {
	e := newEnv(t)
	e.d.Cfg.Collab = true
	e.d.Plan = plan.New(false, 1)
	c, _ := e.signup("onboarding-products")
	c.workspace = c.newWorkspace("Shared inbox")
	ids := func(as ...*client) ([]string, map[string]bool) {
		who := c
		if len(as) > 0 {
			who = as[0]
		}
		r := who.do("GET", "/v1/onboarding", nil)
		if r.Status != 200 {
			t.Fatalf("onboarding: %d %s", r.Status, r.Raw)
		}
		var order []string
		done := map[string]bool{}
		for _, s := range r.Body["steps"].([]any) {
			st := s.(map[string]any)
			order = append(order, st["id"].(string))
			done[st["id"].(string)] = st["done"].(bool)
		}
		if int(r.Body["total"].(float64)) != len(order) {
			t.Fatalf("total: %s", r.Raw)
		}
		return order, done
	}
	if order, _ := ids(); len(order) != 9 || order[0] != "connect_mailbox" {
		t.Fatalf("both products: %v", order)
	}
	// A shared inbox: Tickets off.
	if r := c.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"tickets_enabled": false}}); r.Status != 200 {
		t.Fatalf("tickets off: %d %s", r.Status, r.Raw)
	}
	order, done := ids()
	if len(order) != 4 || order[0] != "connect_mail_account" || order[1] != "share_mail_account" || order[2] != "invite_teammate" || order[3] != "upload_photo" ||
		done["connect_mail_account"] || done["share_mail_account"] {
		t.Fatalf("mail only: %v %v", order, done)
	}
	// An account, then shared with everyone.
	ctx := context.Background()
	var wid, uid uuid.UUID
	if err := e.d.DB.Pool.QueryRow(ctx, `SELECT workspace_id, user_id FROM members WHERE workspace_id = $1::uuid`, c.workspace).Scan(&wid, &uid); err != nil {
		t.Fatal(err)
	}
	// A teammate, an admin: the owner's account counts for them only once they see it.
	mate, mateEmail := e.signup("onboarding-mate")
	if _, err := e.d.DB.Pool.Exec(ctx, `INSERT INTO members (workspace_id, user_id, role) SELECT $1, id, 'admin' FROM users WHERE email = $2`, wid, mateEmail); err != nil {
		t.Fatal(err)
	}
	mate.workspace = c.workspace
	acc := uuid.New()
	if _, err := e.d.DB.Pool.Exec(ctx, `INSERT INTO collab_accounts (id, workspace_id, owner_id, provider, email, visibility)
		VALUES ($1, $2, $3, 'imap', 'team@example.com', 'shared')`, acc, wid, uid); err != nil {
		t.Fatal(err)
	}
	if _, done = ids(); !done["connect_mail_account"] || done["share_mail_account"] {
		t.Fatalf("connected, shared with no one yet: %v", done)
	}
	if _, done = ids(mate); done["connect_mail_account"] || done["share_mail_account"] {
		t.Fatalf("a teammate sees an account shared with no one: %v", done)
	}
	if _, err := e.d.DB.Pool.Exec(ctx, `INSERT INTO collab_shares (id, workspace_id, account_id, everyone) VALUES ($1, $2, $3, true)`, uuid.New(), wid, acc); err != nil {
		t.Fatal(err)
	}
	if _, done = ids(); !done["share_mail_account"] {
		t.Fatalf("shared: %v", done)
	}
	if _, done = ids(mate); !done["connect_mail_account"] || !done["share_mail_account"] {
		t.Fatalf("shared with everyone, for a teammate: %v", done)
	}
}

func TestWorkspaceCannotDisableOnlyAvailableProduct(t *testing.T) {
	for _, tc := range []struct {
		name            string
		instance, cloud bool
		pages           bool
		want            int
	}{
		{"instance disabled", false, false, false, 422},
		{"plan unavailable", true, true, false, 422},
		{"mail available", true, false, false, 200},
		// Pages counts: a workspace may keep Pages alone.
		{"pages only", false, false, true, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			e.d.Cfg.Collab = tc.instance
			e.d.Plan = plan.New(tc.cloud, 1)
			c, _ := e.signup("product-availability")
			c.workspace = c.newWorkspace("Availability review")
			r := c.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"tickets_enabled": false, "pages_enabled": tc.pages}})
			if r.Status != tc.want {
				t.Fatalf("disable Tickets: status=%d want=%d body=%s", r.Status, tc.want, r.Raw)
			}
			current := c.do("GET", "/v1/workspace", nil)
			if tc.want == 422 && current.Body["settings"].(map[string]any)["tickets_enabled"] == false {
				t.Fatal("refused disable changed Tickets")
			}
			if tc.pages && tc.want == 200 {
				// Pages can't go too while it is the last product left.
				if r := c.do("PATCH", "/v1/workspace", map[string]any{"settings": map[string]any{"pages_enabled": false}}); r.Status != 422 {
					t.Fatalf("disable Pages last: status=%d body=%s", r.Status, r.Raw)
				}
			}
		})
	}
}
