package core

import (
	"context"
	"testing"

	"github.com/useopendesk/opendesk/internal/ids"
)

// TestInvitedSharesOnAccept: a shared mail account given to an invitation (GH#447) moves to
// the invitation that replaces it when the address is invited again, and becomes the
// person's share when they accept.
func TestInvitedSharesOnAccept(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	owner, _ := e.signup("owner")
	wid := owner.newWorkspace("Shared Inc")
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := e.d.DB.Pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	var ownerID string
	if err := e.d.DB.Pool.QueryRow(ctx, `SELECT user_id::text FROM members WHERE workspace_id = $1`, wid).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	account := ids.New()
	if _, err := e.d.DB.Pool.Exec(ctx, `INSERT INTO collab_accounts (id, workspace_id, owner_id, provider, email, name, display_name, visibility, credentials_enc, status)
		VALUES ($1, $2, $3, 'imap', 'support@shared.test', 'Support', 'Support', 'shared', '\x00', 'active')`, account, wid, ownerID); err != nil {
		t.Fatal(err)
	}

	email := uniqueEmail(t, "invitee")
	first := owner.do("POST", "/v1/invitations", map[string]any{"email": email, "role": "agent"})
	if first.Status != 201 {
		t.Fatalf("invite: %d %s", first.Status, first.Raw)
	}
	if _, err := e.d.DB.Pool.Exec(ctx, `INSERT INTO collab_invited_shares (account_id, invitation_id, workspace_id) VALUES ($1, $2, $3)`,
		account, first.str("id"), wid); err != nil {
		t.Fatal(err)
	}
	// Invited again: the new invitation keeps the account.
	again := owner.do("POST", "/v1/invitations", map[string]any{"email": email, "role": "agent"})
	if again.Status != 201 || again.str("id") == first.str("id") {
		t.Fatalf("invite again: %d %s", again.Status, again.Raw)
	}
	if n := count(`SELECT count(*) FROM collab_invited_shares WHERE invitation_id = $1 AND account_id = $2`, again.str("id"), account); n != 1 {
		t.Fatalf("pending share moved: %d", n)
	}
	// An expired invitation's account dropped out: neither inviting again nor resending brings it back.
	share := func(inv string) {
		t.Helper()
		if _, err := e.d.DB.Pool.Exec(ctx, `INSERT INTO collab_invited_shares (account_id, invitation_id, workspace_id) VALUES ($1, $2, $3)`, account, inv, wid); err != nil {
			t.Fatal(err)
		}
		if _, err := e.d.DB.Pool.Exec(ctx, `UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, inv); err != nil {
			t.Fatal(err)
		}
	}
	stale := uniqueEmail(t, "stale")
	expired := owner.do("POST", "/v1/invitations", map[string]any{"email": stale, "role": "agent"})
	if expired.Status != 201 {
		t.Fatalf("invite: %d %s", expired.Status, expired.Raw)
	}
	share(expired.str("id"))
	if r := owner.do("POST", "/v1/invitations/"+expired.str("id")+"/resend", nil); r.Status != 200 {
		t.Fatalf("resend: %d %s", r.Status, r.Raw)
	}
	if n := count(`SELECT count(*) FROM collab_invited_shares WHERE invitation_id = $1`, expired.str("id")); n != 0 {
		t.Fatalf("resending an expired invitation kept its account: %d", n)
	}
	share(expired.str("id"))
	reinvited := owner.do("POST", "/v1/invitations", map[string]any{"email": stale, "role": "agent"})
	if reinvited.Status != 201 {
		t.Fatalf("invite again: %d %s", reinvited.Status, reinvited.Raw)
	}
	if n := count(`SELECT count(*) FROM collab_invited_shares WHERE invitation_id = $1`, reinvited.str("id")); n != 0 {
		t.Fatalf("inviting again after expiry kept the account: %d", n)
	}

	_, text := e.lastMail(email)
	token := tokenFromText(text, "/invite?token=")

	invitee := e.client()
	r := invitee.do("POST", "/v1/auth/register", map[string]any{"email": email, "password": goodPassword, "name": "Invitee", "invite_token": token})
	if r.Status != 200 {
		t.Fatalf("register: %d %s", r.Status, r.Raw)
	}
	invitee.token = r.str("access_token")
	if acc := invitee.do("POST", "/v1/invitations/accept", map[string]any{"token": token}); acc.Status != 200 {
		t.Fatalf("accept: %d %s", acc.Status, acc.Raw)
	}
	if n := count(`SELECT count(*) FROM collab_shares s JOIN users u ON u.id = s.user_id WHERE s.account_id = $1 AND u.email = $2`, account, email); n != 1 {
		t.Fatalf("share after accept: %d", n)
	}
	if n := count(`SELECT count(*) FROM collab_invited_shares WHERE account_id = $1`, account); n != 0 {
		t.Fatalf("pending shares left: %d", n)
	}
}
