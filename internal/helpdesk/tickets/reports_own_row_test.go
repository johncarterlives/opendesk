package tickets_test

// A member who is not an admin sees their own row alone, in the overview's by_agent as in the
// Agents report; admins, owners and API keys every member's. On the Agents report's fixture
// (reports_agents_test.go).

import (
	"testing"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
)

func TestReportsOwnRowForMembers(t *testing.T) {
	e, _ := newEnv(t)
	f := seedAgents(t, e)
	ws := f.ws
	overview := func(a hdtest.Auth, query string) tickets.ReportOverview {
		t.Helper()
		var o tickets.ReportOverview
		e.Do("GET", "/v1/reports/overview?"+query, a, nil).Want(t, 200).JSON(t, &o)
		return o
	}
	people := func(rows []tickets.ReportAgent) []uuid.UUID {
		out := make([]uuid.UUID, 0, len(rows))
		for _, r := range rows {
			out = append(out, r.User.ID)
		}
		return out
	}
	has := func(rows []tickets.ReportAgent, id uuid.UUID) *tickets.ReportAgent {
		for i := range rows {
			if rows[i].User.ID == id {
				return &rows[i]
			}
		}
		return nil
	}

	// March: Anna solved t1, t2 and t3; Bea holds t4, open.
	all := overview(ws.Admin.As(ws), march)
	anna, bea := has(all.ByAgent, ws.Agent.ID), has(all.ByAgent, f.bea.ID)
	if len(all.ByAgent) != 2 || anna == nil || bea == nil || anna.Solved != 3 || bea.Solved != 0 {
		t.Fatalf("admin by_agent %+v", all.ByAgent)
	}
	if o := overview(ws.Owner.As(ws), march); len(o.ByAgent) != 2 {
		t.Fatalf("owner by_agent %v", people(o.ByAgent))
	}
	key := hdtest.Auth{Bearer: e.APIKey(ws, auth.ScopeTicketsRead)}
	if o := overview(key, march); len(o.ByAgent) != 2 {
		t.Fatalf("API key by_agent %v", people(o.ByAgent))
	}

	// Anna and Bea, agents, each get their own row, with the figures an admin sees for them.
	o := overview(ws.Agent.As(ws), march)
	if len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != ws.Agent.ID || o.ByAgent[0].Solved != anna.Solved || !sameMinutes(o.ByAgent[0].FirstResponseP50Minutes, anna.FirstResponseP50Minutes) {
		t.Fatalf("anna by_agent %+v, admin's row %+v", o.ByAgent, *anna)
	}
	// The figures that name nobody stay the team's.
	if o.Created != all.Created || o.Solved != all.Solved || o.OpenNow != all.OpenNow || !sameMinutes(o.FirstResponseP50Minutes, all.FirstResponseP50Minutes) || len(o.ByTeam) != len(all.ByTeam) {
		t.Fatalf("anna totals %+v, admin's %+v", o, all)
	}
	if o = overview(f.bea.As(ws), march); len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != f.bea.ID {
		t.Fatalf("bea by_agent %v", people(o.ByAgent))
	}
	// With a filter too: Bea's team.
	if o = overview(f.bea.As(ws), march+"&team_id="+f.team.String()); len(o.ByAgent) != 1 || o.ByAgent[0].User.ID != f.bea.ID {
		t.Fatalf("bea team by_agent %v", people(o.ByAgent))
	}
	// Carl and the viewer hold no ticket: an empty by_agent, never someone else's row.
	for name, a := range map[string]hdtest.Auth{"carl": f.carl.As(ws), "viewer": ws.Viewer.As(ws)} {
		if o = overview(a, march); len(o.ByAgent) != 0 || o.Created != all.Created {
			t.Fatalf("%s by_agent %v created %d", name, people(o.ByAgent), o.Created)
		}
	}

	// The Agents report already answers a member their own row alone (online_time self).
	if r := agentsReport(t, e, f.bea.As(ws), march); len(r.Data) != 1 || r.Data[0].User.ID != f.bea.ID || r.OnlineTime != "self" {
		t.Fatalf("bea agents rows %+v (%s)", r.Data, r.OnlineTime)
	}
	if r := agentsReport(t, e, ws.Agent.As(ws), march); len(r.Data) != 1 || r.Data[0].User.ID != ws.Agent.ID {
		t.Fatalf("anna agents rows %+v", r.Data)
	}
	if r := agentsReport(t, e, ws.Admin.As(ws), march); len(r.Data) < 2 {
		t.Fatalf("admin agents rows %+v", r.Data)
	}
	// Also with online time off for the workspace: still their own row.
	e.SetSettings(ws, map[string]any{"agent_online_time": false})
	if r := agentsReport(t, e, f.bea.As(ws), march); len(r.Data) != 1 || r.Data[0].User.ID != f.bea.ID || r.OnlineTime != "off" {
		t.Fatalf("bea agents rows, online time off %+v (%s)", r.Data, r.OnlineTime)
	}
}

func sameMinutes(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
