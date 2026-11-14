package contacts_test

import (
	"net/url"
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

type named struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"ticket_count"`
}

// listNames reads every page of a list the way the app does, following next_cursor.
func listNames(t *testing.T, e *hdtest.Env, auth hdtest.Auth, path string, limit int) []string {
	t.Helper()
	var out []string
	cursor := ""
	for range 20 {
		sep := "?"
		if len(path) > 0 && containsQuery(path) {
			sep = "&"
		}
		full := path + sep + "limit=" + url.QueryEscape(itoa(limit))
		if cursor != "" {
			full += "&cursor=" + url.QueryEscape(cursor)
		}
		var p struct {
			Data       []named `json:"data"`
			NextCursor *string `json:"next_cursor"`
		}
		e.Do("GET", full, auth, nil).Want(t, 200).JSON(t, &p)
		for _, c := range p.Data {
			out = append(out, c.Name)
		}
		if p.NextCursor == nil {
			return out
		}
		cursor = *p.NextCursor
	}
	t.Fatal("a list never ended")
	return nil
}

func containsQuery(s string) bool {
	for _, r := range s {
		if r == '?' {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	if s == "" {
		return "0"
	}
	return s
}

func TestContactListSortAndBlockedFilter(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	people := []struct {
		name    string
		blocked bool
		tickets int
	}{{"bea", false, 3}, {"Adam", true, 0}, {"cleo", false, 1}, {"Dora", false, 2}, {"eli", true, 5}}
	for i, p := range people {
		id := ids.New()
		e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, blocked, created_at) VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))`,
			id, ws.ID, p.name, p.name+"@example.com", p.blocked, len(people)-i)
		for range p.tickets {
			e.Exec(`INSERT INTO tickets (id, workspace_id, number, subject, contact_id, channel, brand_id) VALUES ($1, $2, (SELECT COALESCE(max(number), 0) + 1 FROM tickets WHERE workspace_id = $2), 'x', $3, 'api', $4)`, ids.New(), ws.ID, id, ws.BrandID)
		}
	}
	for sort, want := range map[string][]string{
		"name":     {"Adam", "bea", "cleo", "Dora", "eli"},
		"-name":    {"eli", "Dora", "cleo", "bea", "Adam"},
		"-tickets": {"eli", "bea", "Dora", "cleo", "Adam"},
		"created":  {"bea", "Adam", "cleo", "Dora", "eli"},
		"-created": {"eli", "Dora", "cleo", "Adam", "bea"},
		"":         {"eli", "Dora", "cleo", "Adam", "bea"},
	} {
		// Two to a page, so each sort is read across pages.
		path := "/v1/contacts"
		if sort != "" {
			path += "?sort=" + sort
		}
		if got := listNames(t, e, a, path, 2); !slices.Equal(got, want) {
			t.Errorf("sort %q: got %v, want %v", sort, got, want)
		}
	}
	if got := listNames(t, e, a, "/v1/contacts?blocked=true&sort=name", 10); !slices.Equal(got, []string{"Adam", "eli"}) {
		t.Errorf("blocked: %v", got)
	}
	if got := listNames(t, e, a, "/v1/contacts?blocked=false&sort=-tickets", 10); !slices.Equal(got, []string{"bea", "Dora", "cleo"}) {
		t.Errorf("not blocked: %v", got)
	}
	e.Do("GET", "/v1/contacts?sort=drop-table", a, nil).Want(t, 422)
	e.Do("GET", "/v1/contacts?blocked=maybe", a, nil).Want(t, 422)

	// Another workspace's contacts never join a sorted list.
	other := e.NewWorkspace()
	if got := listNames(t, e, other.Agent.As(other), "/v1/contacts?sort=name", 10); len(got) != 0 {
		t.Errorf("another workspace's list holds %v", got)
	}
}

func TestCompanyListSort(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	for i, name := range []string{"beta", "Acme", "gamma"} {
		id := ids.New()
		e.Exec(`INSERT INTO companies (id, workspace_id, name, created_at) VALUES ($1, $2, $3, now() - make_interval(mins => $4))`, id, ws.ID, name, 3-i)
		for j := 0; j < i; j++ {
			e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, company_id) VALUES ($1, $2, 'p', $3, $4)`, ids.New(), ws.ID, ids.New().String()+"@example.com", id)
		}
	}
	for sort, want := range map[string][]string{
		"":          {"Acme", "beta", "gamma"},
		"name":      {"Acme", "beta", "gamma"},
		"-name":     {"gamma", "beta", "Acme"},
		"-contacts": {"gamma", "Acme", "beta"},
		"contacts":  {"beta", "Acme", "gamma"},
		"-created":  {"gamma", "Acme", "beta"},
	} {
		path := "/v1/companies"
		if sort != "" {
			path += "?sort=" + sort
		}
		if got := listNames(t, e, a, path, 2); !slices.Equal(got, want) {
			t.Errorf("sort %q: got %v, want %v", sort, got, want)
		}
	}
	e.Do("GET", "/v1/companies?sort=nope", a, nil).Want(t, 422)
}

// Every sort pages by key: a record added before the page read so far, or one deleted after
// it, neither repeats nor skips a record on the next page, and equal values all come through.
func TestDirectoryListPagesByKey(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	for _, n := range []string{"Adam", "bea", "cleo", "Dora"} {
		e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, $3, $4)`, ids.New(), ws.ID, n, n+"@example.com")
	}
	var first struct {
		Data       []named `json:"data"`
		NextCursor *string `json:"next_cursor"`
	}
	e.Do("GET", "/v1/contacts?sort=name&limit=2", a, nil).Want(t, 200).JSON(t, &first)
	if len(first.Data) != 2 || first.Data[1].Name != "bea" || first.NextCursor == nil {
		t.Fatalf("first page %+v", first)
	}
	// Someone adds "Aaron" (before the cursor) and deletes "cleo" (after it).
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, 'Aaron', 'aaron@example.com')`, ids.New(), ws.ID)
	e.Exec(`DELETE FROM contacts WHERE workspace_id = $1 AND name = 'cleo'`, ws.ID)
	var next struct {
		Data []named `json:"data"`
	}
	e.Do("GET", "/v1/contacts?sort=name&limit=2&cursor="+url.QueryEscape(*first.NextCursor), a, nil).Want(t, 200).JSON(t, &next)
	if len(next.Data) != 1 || next.Data[0].Name != "Dora" {
		t.Fatalf("second page %+v", next.Data)
	}
	// A cursor belongs to its sort.
	e.Do("GET", "/v1/contacts?sort=-tickets&cursor="+url.QueryEscape(*first.NextCursor), a, nil).Want(t, 400)

	// Ties: five people with one name and no tickets, one to a page, each read once.
	for range 5 {
		e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, created_at) VALUES ($1, $2, 'Same', $3, '2026-01-01T00:00:00Z')`, ids.New(), ws.ID, ids.New().String()+"@example.com")
	}
	for _, sort := range []string{"name", "-name", "tickets", "-tickets", "created", "-created", "updated", "-updated"} {
		got := listNames(t, e, a, "/v1/contacts?sort="+sort, 1)
		if len(got) != 9 || len(slices.Compact(slices.Sorted(slices.Values(got)))) != 5 {
			t.Errorf("sort %q read %v", sort, got)
		}
	}

	// People without a company.
	co := ids.New()
	e.Exec(`INSERT INTO companies (id, workspace_id, name) VALUES ($1, $2, 'Acme')`, co, ws.ID)
	e.Exec(`UPDATE contacts SET company_id = $2 WHERE workspace_id = $1 AND name <> 'Same'`, ws.ID, co)
	if got := listNames(t, e, a, "/v1/contacts?company_id=none&sort=name", 10); len(got) != 5 {
		t.Errorf("no company: %v", got)
	}
	if got := listNames(t, e, a, "/v1/contacts?company_id="+co.String()+"&sort=name", 10); !slices.Equal(got, []string{"Aaron", "Adam", "bea", "Dora"}) {
		t.Errorf("company: %v", got)
	}

	// Companies page by key too, in every order.
	for i := range 4 {
		e.Exec(`INSERT INTO companies (id, workspace_id, name) VALUES ($1, $2, $3)`, ids.New(), ws.ID, []string{"beta", "Beta", "gamma", "beta"}[i])
	}
	for _, sort := range []string{"", "name", "-name", "contacts", "-contacts", "created", "-created", "updated", "-updated"} {
		path := "/v1/companies"
		if sort != "" {
			path += "?sort=" + sort
		}
		if got := listNames(t, e, a, path, 1); len(got) != 5 {
			t.Errorf("companies sort %q read %v", sort, got)
		}
	}
}
