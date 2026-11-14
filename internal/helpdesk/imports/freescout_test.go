package imports

import (
	"github.com/useopendesk/opendesk/internal/helpdesk/imports/source"
	"testing"
)

// The source-specific HTTP tests pin FreeScout's wire format. This runs its source key
// through the API schema, database constraint and normal resumable import/undo engine.
func TestFreeScoutImportLifecycle(t *testing.T) {
	e := newEnv(t)
	if e.s.Factories[FreeScout] == nil {
		t.Fatal("FreeScout source is not registered")
	}
	e.f.scan.Account = source.Account{Key: "https://support.example.test", Name: "Support", URL: "https://support.example.test"}
	e.f.scan.HasArticles = false
	e.f.scan.Articles = 0
	e.f.articles = nil
	e.s.Factories[FreeScout] = e.f.factory
	body := e.zendeskBody()
	body["source"] = FreeScout
	var checked ImportCheck
	e.Do("POST", "/v1/imports/check", e.admin, map[string]any{"source": FreeScout, "credentials": body["credentials"]}).Want(t, 200).JSON(t, &checked)
	if checked.HasArticles || len(checked.Samples) == 0 {
		t.Fatalf("check = %+v", checked)
	}
	e.Do("POST", "/v1/imports", e.ws.Agent.As(e.ws), body).Want(t, 403)
	x := e.start(t, body)
	done := e.drive(t, x.ID)
	if done.Source != FreeScout || done.Status != StatusCompleted || done.Counts.Tickets != 3 || done.Counts.Messages == 0 || done.Counts.Articles != 0 {
		t.Fatalf("completed import = %+v", done.Import)
	}
	e.Do("POST", "/v1/imports/"+x.ID.String()+"/sync", e.admin, nil).Want(t, 200)
	again := e.drive(t, x.ID)
	if again.Counts.Tickets != done.Counts.Tickets || again.Counts.Messages != done.Counts.Messages {
		t.Fatal("sync duplicated history")
	}
	e.Do("POST", "/v1/imports/"+x.ID.String()+"/undo", e.admin, nil).Want(t, 200)
	undone := e.driveUndo(t, x.ID)
	if undone.Status != StatusUndone {
		t.Fatalf("undo = %s", undone.Status)
	}
}
