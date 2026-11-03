package core

import (
	"context"
	"github.com/google/uuid"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/tickets"
	"testing"
	"time"
)

func TestMemberRemovalLeavesWorkspaceAvailableToTicketWriter(t *testing.T) {
	f := newTeamFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	team := uuid.New()
	f.exec(`INSERT INTO teams(id,workspace_id,name,private) VALUES($1,$2,'Private',true)`, team, f.wid)
	f.exec(`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, f.agentID)
	ticket := f.ticket(&team, &f.agentID)
	gate, err := f.e.d.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(context.Background())
	var pid int32
	if err := gate.QueryRow(ctx, `SELECT pg_backend_pid() FROM tickets WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, f.wid, ticket).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan resp, 1)
	go func() { done <- f.owner.do("DELETE", "/v1/members/"+f.agentID.String(), nil) }()
	for {
		var blocked bool
		if err := f.e.d.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case r := <-done:
			t.Fatalf("removal returned before waiting for ticket: %d %s", r.Status, r.Raw)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	_, lockErr := gate.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT`, f.wid)
	gate.Rollback(context.Background())
	select {
	case r := <-done:
		if r.Status != 204 {
			t.Fatalf("removal: %d %s", r.Status, r.Raw)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if lockErr != nil {
		t.Fatalf("ticket-first writer cannot obtain workspace while removal waits for its ticket: %v", lockErr)
	}
}

func TestMemberRemovalAndTicketEdit(t *testing.T) {
	f := newTeamFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	team := uuid.New()
	f.exec(`INSERT INTO teams(id,workspace_id,name,private) VALUES($1,$2,'Private',true)`, team, f.wid)
	f.exec(`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, f.agentID)
	ticket := f.ticket(&team, &f.agentID)
	gate, err := f.e.d.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(context.Background())
	var pid int32
	if err := gate.QueryRow(ctx, `SELECT pg_backend_pid() FROM tickets WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, f.wid, ticket).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan resp, 1)
	go func() { done <- f.owner.do("DELETE", "/v1/members/"+f.agentID.String(), nil) }()
	for {
		var blocked bool
		if err := f.e.d.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case r := <-done:
			t.Fatalf("removal returned before waiting for ticket: %d %s", r.Status, r.Raw)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	subject := "Changed while member removal waits"
	_, lockErr := tickets.ApplyPatch(ctx, gate, f.e.d, &auth.Principal{Kind: auth.KindUser, UserID: f.ownerID, WorkspaceID: f.wid, Role: auth.RoleOwner}, ticket, tickets.Patch{Subject: &subject})
	t.Logf("actual ticket patch result: %v", lockErr)
	if lockErr == nil {
		if err := gate.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	} else {
		gate.Rollback(context.Background())
	}
	select {
	case r := <-done:
		if r.Status != 204 {
			t.Fatalf("removal: %d %s", r.Status, r.Raw)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var saved string
	var assignee *uuid.UUID
	if err := f.e.d.DB.Pool.QueryRow(ctx, `SELECT subject, assignee_id FROM tickets WHERE workspace_id=$1 AND id=$2`, f.wid, ticket).Scan(&saved, &assignee); err != nil {
		t.Fatal(err)
	}
	if saved != subject || assignee != nil {
		t.Fatalf("edit and removal did not both commit: subject=%q assignee=%v", saved, assignee)
	}

	if lockErr != nil {
		t.Fatalf("ticket-first writer cannot obtain workspace while removal waits for its ticket: %v", lockErr)
	}
}
