package collab

import (
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/ids"
)

// A shared account given to someone invited (GH#447): listed as invited until they accept,
// then theirs, and no one else's. contracts/collab.md "Who sees what".
func TestAPIAccountSharedWithInvitee(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityShared, Audience{})
	srv := w.api(w.agent)
	inv := ids.New()
	mustExec(t, w.d, `INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
		VALUES ($1, $2, $3, 'agent', $4, $5, now() + interval '7 days')`,
		inv, w.wid, "new-"+crypto.RandomString(6)+"@example.com", []byte(inv.String()), w.owner.UserID)
	url := srv.URL + "/v1/collab/accounts/" + a.ID.String()

	var out MailAccount
	st := doJSON(t, "PATCH", url, map[string]any{"shared_with": Audience{Invited: []Invitee{{ID: inv}}}}, &out)
	if st != 200 || len(out.SharedWith.Invited) != 1 || out.SharedWith.Invited[0].ID != inv || out.SharedWith.Invited[0].Email == "" {
		t.Fatalf("share with an invitee: %d %+v", st, out.SharedWith)
	}
	// An invitation no longer pending (accepted, revoked or expired meanwhile) drops out quietly.
	gone := Audience{UserIDs: []uuid.UUID{w.agent2.UserID}, Invited: []Invitee{{ID: inv}, {ID: uuid.New()}}}
	if st := doJSON(t, "PATCH", url, map[string]any{"shared_with": gone}, &out); st != 200 ||
		len(out.SharedWith.Invited) != 1 || out.SharedWith.Invited[0].ID != inv || len(out.SharedWith.UserIDs) != 1 {
		t.Fatalf("stale invitation: %d %+v", st, out.SharedWith)
	}
	// Another change keeps the invitee.
	if st := doJSON(t, "PATCH", url, map[string]any{"color": "teal"}, &out); st != 200 || len(out.SharedWith.Invited) != 1 {
		t.Fatalf("invitee kept: %d %+v", st, out.SharedWith)
	}
	// Who sees the account but does not manage it does not see who was invited.
	var seen []MailAccount
	if st := doJSON(t, "GET", w.api(w.agent2).URL+"/v1/collab/accounts", nil, &seen); st != 200 || len(seen) != 1 || seen[0].SharedWith.Invited != nil {
		t.Fatalf("invitees shown to a member who does not manage the account: %d %+v", st, seen)
	}
	// Back to the invitee alone for the rest.
	if st := doJSON(t, "PATCH", url, map[string]any{"shared_with": Audience{Invited: []Invitee{{ID: inv}}}}, &out); st != 200 || len(out.SharedWith.UserIDs) != 0 {
		t.Fatalf("reset: %d %+v", st, out.SharedWith)
	}

	// They accept (the core accept path calls ApplyInvitedShares in its transaction).
	joined := w.member("Nina New", auth.RoleAgent)
	tx, err := w.d.DB.Pool.Begin(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	n, err := ApplyInvitedShares(w.ctx, tx, w.wid, inv, joined.UserID)
	if err != nil || n != 1 {
		t.Fatalf("apply: %d %v", n, err)
	}
	if err := tx.Commit(w.ctx); err != nil {
		t.Fatal(err)
	}
	if st := doJSON(t, "GET", w.api(joined).URL+"/v1/collab/accounts", nil, &seen); st != 200 || len(seen) != 1 || seen[0].ID != a.ID {
		t.Fatalf("the invitee does not see the account: %d %+v", st, seen)
	}
	if st := doJSON(t, "GET", w.api(w.agent2).URL+"/v1/collab/accounts", nil, &seen); st != 200 || len(seen) != 0 {
		t.Fatalf("another member sees it: %d %+v", st, seen)
	}
	if n := w.count(`SELECT count(*) FROM collab_invited_shares WHERE invitation_id = $1`, inv); n != 0 {
		t.Fatalf("pending shares left: %d", n)
	}
	if st := doJSON(t, "GET", srv.URL+"/v1/collab/accounts", nil, &seen); st != 200 || len(seen) != 1 ||
		len(seen[0].SharedWith.UserIDs) != 1 || seen[0].SharedWith.UserIDs[0] != joined.UserID || len(seen[0].SharedWith.Invited) != 0 {
		t.Fatalf("after accept: %d %+v", st, seen)
	}
}
