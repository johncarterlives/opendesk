package ai

import (
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/config"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/ids"
)

func TestArticleURLUsesTheBrandHelpCenter(t *testing.T) {
	s := &Service{d: &deps.Deps{Cfg: &config.Config{AppURL: "https://app.test"}}}
	if got := s.articleURL(nil, "acme-eu", "/a/reset-password"); got != "https://app.test/help/acme-eu/a/reset-password" {
		t.Fatalf("article url %q", got)
	}
	s.d.Cfg.HelpDomain = "help.test"
	if got := s.articleURL(nil, "acme-eu", "/a/reset-password"); got != "https://acme-eu.help.test/a/reset-password" {
		t.Fatalf("article url on the help domain %q", got)
	}
	if got := s.articleURL(map[string]string{"acme-eu": "support.acme.eu"}, "acme-eu", "/a/reset-password"); got != "https://support.acme.eu/a/reset-password" {
		t.Fatalf("article url on a custom domain %q", got)
	}
}

func TestKBBrandSQL(t *testing.T) {
	got := kbBrandSQL(6)
	for _, want := range []string{"$6::uuid IS NULL", "COALESCE(kc.brand_id, a.brand_id) IS NULL", "= $6::uuid"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q lacks %q", got, want)
		}
	}
	if ticketBrand(domain.Ticket{}) != nil {
		t.Fatal("a ticket without a brand reads every brand")
	}
	b := uuid.New()
	if p := ticketBrand(domain.Ticket{BrandID: b}); p == nil || *p != b {
		t.Fatal("ticket brand lost")
	}
}

// defaultBrand returns the workspace's default brand, creating it when the workspace
// predates brands in the test helpers.
func (e *env) defaultBrand() uuid.UUID {
	e.T.Helper()
	e.Exec(`INSERT INTO brands (workspace_id, name, slug, is_default) SELECT w.id, w.name, w.slug, true FROM workspaces w
		WHERE w.id = $1 AND NOT EXISTS (SELECT 1 FROM brands b WHERE b.workspace_id = w.id AND b.is_default)`, e.WS.ID)
	var id uuid.UUID
	e.Scalar(`SELECT id FROM brands WHERE workspace_id = $1 AND is_default`, &id, e.WS.ID)
	return id
}

func TestKBRetrievalIsPerBrand(t *testing.T) {
	e := newEnv(t, opts{noEmbed: true})
	e.S.vectors = false
	def := e.defaultBrand()
	other := ids.New()
	otherSlug := "other-" + other.String()[24:]
	e.Exec(`INSERT INTO brands (id, workspace_id, name, slug) VALUES ($1, $2, $3, $4)`, other, e.WS.ID, "Other "+otherSlug, otherSlug)

	shared := e.article("Reset your password", "<p>To reset your password open the sign-in page and choose Forgot password.</p>", "published")
	own := e.article("Reset your password on Other", "<p>Other customers reset the password from the Other app settings.</p>", "published")
	e.Exec(`UPDATE kb_articles SET brand_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, own, other)
	coll := ids.New()
	e.Exec(`INSERT INTO kb_collections (id, workspace_id, name, slug, brand_id) VALUES ($1, $2, 'Other help', $3, $4)`,
		coll, e.WS.ID, "c-"+coll.String()[24:], other)
	inherited := e.article("Password reset for Other teams", "<p>Team admins of Other reset a password for their members.</p>", "published")
	e.Exec(`UPDATE kb_articles SET collection_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, inherited, coll)

	found := func(brand *uuid.UUID) map[uuid.UUID]string {
		t.Helper()
		src, err := e.S.retrieveKB(e.Ctx, e.WS.ID, brand, "How do I reset my password?", 10, false)
		if err != nil {
			t.Fatal(err)
		}
		out := map[uuid.UUID]string{}
		for _, s := range src {
			out[uuid.MustParse(s.ArticleID)] = s.URL
		}
		return out
	}
	urlOf := func(slug string, article uuid.UUID) string {
		var a string
		e.Scalar(`SELECT COALESCE('/c/' || k.slug || '/', '/a/') || a.slug FROM kb_articles a LEFT JOIN kb_collections k ON k.id = a.collection_id
			WHERE a.id = $1`, &a, article)
		return e.D.Cfg.AppURL + "/help/" + slug + a
	}

	// The default brand's tickets see shared articles only, linked on its help center.
	got := found(&def)
	if len(got) != 1 || got[shared] != urlOf(e.WS.Slug, shared) {
		t.Fatalf("default brand: %v", got)
	}
	// Another brand's tickets see the shared articles, its own and its collections'.
	got = found(&other)
	if len(got) != 3 || got[shared] != urlOf(otherSlug, shared) || got[own] != urlOf(otherSlug, own) ||
		got[inherited] != urlOf(otherSlug, inherited) {
		t.Fatalf("other brand: %v", got)
	}
	// Without a ticket every brand's articles are read, each on its own help center.
	got = found(nil)
	if len(got) != 3 || got[shared] != urlOf(e.WS.Slug, shared) || got[own] != urlOf(otherSlug, own) {
		t.Fatalf("no brand: %v", got)
	}
}

func TestPrivateTeamTicketsInAI(t *testing.T) {
	e := newEnv(t, opts{noEmbed: true})
	e.S.vectors = false
	e.defaultBrand()
	team := ids.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, private) VALUES ($1, $2, 'Security', true)`, team, e.WS.ID)
	e.Exec(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, team, e.WS.Admin.ID)
	tk := e.ticket("Vulnerability xyzzy report", "I found an xyzzy vulnerability in your sign-in page")
	e.Exec(`UPDATE tickets SET team_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, tk.ID, team)
	id := tk.ID.String()

	// Off the team: every AI route on the ticket is not found, and search leaves it out.
	e.Do("POST", "/v1/tickets/"+id+"/ai/summary", e.agent(), map[string]any{}).Want(t, 404)
	e.Do("POST", "/v1/tickets/%23"+strconv.FormatInt(tk.Number, 10)+"/ai/ask", e.agent(), map[string]any{"question": "What happened?"}).Want(t, 404)
	e.Do("POST", "/v1/tickets/"+id+"/ai/draft", e.agent(), map[string]any{}).Want(t, 404)
	e.Do("GET", "/v1/tickets/"+id+"/ai/suggested-reply", e.agent(), nil).Want(t, 404)
	e.Do("DELETE", "/v1/tickets/"+id+"/ai/suggestions/team", e.agent(), nil).Want(t, 404)
	var res AISearchResults
	e.Do("GET", "/v1/ai/search?q=xyzzy+vulnerability", e.agent(), nil).Want(t, 200).JSON(t, &res)
	if len(res.Tickets) != 0 {
		t.Fatalf("search showed a private team's ticket: %+v", res.Tickets)
	}

	// On the team, and as its assignee, the ticket is there.
	e.Do("GET", "/v1/tickets/"+id+"/ai/suggested-reply", e.admin(), nil).Want(t, 200)
	e.Do("GET", "/v1/ai/search?q=xyzzy+vulnerability", e.admin(), nil).Want(t, 200).JSON(t, &res)
	if len(res.Tickets) != 1 || res.Tickets[0].ID != tk.ID {
		t.Fatalf("member search: %+v", res.Tickets)
	}
	e.Exec(`UPDATE tickets SET assignee_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, tk.ID, e.WS.Agent.ID)
	e.Do("GET", "/v1/tickets/"+id+"/ai/suggested-reply", e.agent(), nil).Want(t, 200)
}

func TestTriageRoutesToATeam(t *testing.T) {
	e := newEnv(t, opts{noEmbed: true})
	brand := e.defaultBrand()
	team := ids.New()
	e.Exec(`INSERT INTO teams (id, workspace_id, name, description, private) VALUES ($1, $2, 'Billing', 'Invoices and refunds', true)`, team, e.WS.ID)
	o, err := loadTriageOptions(e.Ctx, e.D.DB.Pool, e.WS.ID)
	if err != nil || len(o.teams) != 1 || o.teams[0].desc != "Invoices and refunds" {
		t.Fatalf("options %+v %v", o.teams, err)
	}
	q := triageQuestions(o)
	if _, ok := q["team"]; !ok {
		t.Fatal("no team question")
	}

	// The reply address follows the team when the current one has no team.
	general, billing := ids.New(), ids.New()
	for _, m := range []struct {
		id   uuid.UUID
		team *uuid.UUID
	}{{general, nil}, {billing, &team}} {
		e.Exec(`INSERT INTO mailboxes (id, workspace_id, name, email, inbound_kind, forwarding_token, outbound_kind, brand_id, team_id, status)
			VALUES ($1, $2, 'Box', $3, 'forwarding', $6, 'system', $4, $5, 'active')`, m.id, e.WS.ID, "box-"+m.id.String()[24:]+"@example.com", brand, m.team,
			m.id.String())
	}
	tk := e.ticket("Refund for invoice 7", "Please refund invoice 7")
	e.Exec(`UPDATE tickets SET mailbox_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, tk.ID, general)

	v := team.String()
	tr := &Triage{TeamID: &v, team: &team, Sentiment: "neutral", Language: "en", Category: "refund"}
	var changes []string
	err = e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		changes, err = applyTriage(e.Ctx, tx, e.WS.ID, tk.ID, tr, false, "ai_triage")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	got := e.loadTicket(tk.ID)
	if got.TeamID == nil || *got.TeamID != team || got.Routed == nil || got.Routed.Via != "triage" {
		t.Fatalf("team %v routed %+v", got.TeamID, got.Routed)
	}
	if got.MailboxID == nil || *got.MailboxID != billing || !strings.Contains(strings.Join(changes, ","), "mailbox_id") {
		t.Fatalf("reply address %v changes %v", got.MailboxID, changes)
	}
	var via, trigger, from string
	e.Scalar(`SELECT data->>'via' || '|' || (data->>'trigger') || '|' || (data->>'mailbox_from') FROM activities
		WHERE workspace_id = $1 AND ticket_id = $2 AND type = 'team_changed'`, &via, e.WS.ID, tk.ID)
	parts := strings.SplitN(via, "|", 3)
	if len(parts) == 3 {
		via, trigger, from = parts[0], parts[1], parts[2]
	}
	if via != "triage" || trigger != "ai_triage" || from != general.String() {
		t.Fatalf("team_changed %q %q %q", via, trigger, from)
	}
	// Moving into a private team tells other agents to drop the ticket.
	if n := e.count(`SELECT count(*) FROM events WHERE workspace_id = $1 AND type = 'ticket.hidden' AND data->>'ticket_id' = $2`,
		e.WS.ID, tk.ID.String()); n != 1 {
		t.Fatalf("ticket.hidden events: %d", n)
	}

	// A private team never takes a ticket whose assignee is off the team: it stays a suggestion.
	tk2 := e.ticket("Refund for invoice 8", "Please refund invoice 8")
	e.Exec(`UPDATE tickets SET assignee_id = $3 WHERE workspace_id = $1 AND id = $2`, e.WS.ID, tk2.ID, e.WS.Agent.ID)
	tr2 := &Triage{TeamID: &v, team: &team, Sentiment: "neutral", Language: "en", Category: "refund"}
	err = e.D.DB.Tx(e.Ctx, func(tx pgx.Tx) error {
		_, err := applyTriage(e.Ctx, tx, e.WS.ID, tk2.ID, tr2, false, "ai_triage")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := e.loadTicket(tk2.ID); got.TeamID != nil || tr2.Suggestions["team"].Value != v {
		t.Fatalf("assignee off the team: team %v suggestions %+v", got.TeamID, tr2.Suggestions)
	}
}
