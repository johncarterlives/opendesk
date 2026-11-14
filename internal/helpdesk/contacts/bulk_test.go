package contacts_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/contacts"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/ids"
)

type bulkOut struct {
	Updated int `json:"updated"`
	Deleted int `json:"deleted"`
}

func count(e *hdtest.Env, sql string, args ...any) int {
	var n int
	e.Scalar(sql, &n, args...)
	return n
}

func TestBulkContacts(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	company := ids.New()
	e.Exec(`INSERT INTO companies (id, workspace_id, name) VALUES ($1, $2, 'Acme')`, company, ws.ID)
	var people []string
	for i := range 5 {
		id := ids.New()
		e.Exec(`INSERT INTO contacts (id, workspace_id, name, email, blocked) VALUES ($1, $2, $3, $4, $5)`, id, ws.ID, fmt.Sprintf("p%d", i), fmt.Sprintf("p%d@example.com", i), i >= 3)
		people = append(people, id.String())
	}

	// Labels by id: added to some, removed again, all or nothing.
	var out bulkOut
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:3], "patch": map[string]any{"add_tags": []string{"vip"}}}).Want(t, 200).JSON(t, &out)
	if out.Updated != 3 || out.Deleted != 0 {
		t.Fatalf("labelled %+v", out)
	}
	if n := count(e, `SELECT count(*) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.workspace_id = $1 AND t.name = 'vip'`, ws.ID); n != 3 {
		t.Fatalf("%d labelled", n)
	}
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:1], "patch": map[string]any{"remove_tags": []string{"vip"}}}).Want(t, 200)
	if n := count(e, `SELECT count(*) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.workspace_id = $1 AND t.name = 'vip'`, ws.ID); n != 2 {
		t.Fatalf("%d labelled after removing one", n)
	}

	// The company is set, and cleared with null.
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:2], "patch": map[string]any{"company_id": company.String()}}).Want(t, 200)
	if n := count(e, `SELECT count(*) FROM contacts WHERE company_id = $1`, company); n != 2 {
		t.Fatalf("%d in the company", n)
	}
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:1], "patch": map[string]any{"company_id": nil}}).Want(t, 200)
	if n := count(e, `SELECT count(*) FROM contacts WHERE company_id = $1`, company); n != 1 {
		t.Fatalf("%d in the company after clearing one", n)
	}
	other := e.NewWorkspace()
	otherCompany := ids.New()
	e.Exec(`INSERT INTO companies (id, workspace_id, name) VALUES ($1, $2, 'Elsewhere')`, otherCompany, other.ID)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:1], "patch": map[string]any{"company_id": otherCompany.String()}}).Want(t, 422)

	// A filter selects the records: the blocked ones.
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{"blocked": "true"}, "patch": map[string]any{"add_tags": []string{"spam"}}}).Want(t, 200).JSON(t, &out)
	if out.Updated != 2 {
		t.Fatalf("filter updated %d", out.Updated)
	}
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{"tag": "vip", "blocked": "false"}, "delete": true}).Want(t, 200).JSON(t, &out)
	if out.Deleted != 2 {
		t.Fatalf("filter deleted %d", out.Deleted)
	}

	// Refusals change nothing: an id of another workspace, a malformed body, a viewer.
	left := count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, ws.ID)
	foreign := ids.New()
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, 'x', 'x@example.com')`, foreign, other.ID)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": []string{people[4], foreign.String()}, "delete": true}).Want(t, 404)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[3:], "delete": true, "patch": map[string]any{}}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"delete": true}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[3:], "query": map[string]any{}, "delete": true}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", ws.Viewer.As(ws), map[string]any{"ids": people[3:], "delete": true}).Want(t, 403)
	e.Do("POST", "/v1/contacts/bulk", hdtest.Auth{}, map[string]any{"ids": people[3:], "delete": true}).Want(t, 401)
	if n := count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, ws.ID); n != left {
		t.Fatalf("a refused request deleted contacts: %d, was %d", n, left)
	}
	if n := count(e, `SELECT count(*) FROM contacts WHERE id = $1`, foreign); n != 1 {
		t.Fatal("another workspace's contact was deleted")
	}

	// Deleting keeps the contact's tickets, without a contact, and audits each record.
	tk := ids.New()
	e.Exec(`INSERT INTO tickets (id, workspace_id, number, subject, contact_id, channel, brand_id) VALUES ($1, $2, 1, 'x', $3, 'api', $4)`, tk, ws.ID, people[4], ws.BrandID)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[3:], "delete": true}).Want(t, 200).JSON(t, &out)
	if out.Deleted != 2 || count(e, `SELECT count(*) FROM tickets WHERE id = $1 AND contact_id IS NULL`, tk) != 1 {
		t.Fatalf("delete %+v", out)
	}
	if n := count(e, `SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'contact.deleted'`, ws.ID); n != 4 {
		t.Fatalf("%d deletes audited", n)
	}
}

func TestBulkContactsLimits(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) SELECT gen_random_uuid(), $1, 'p' || g, 'p' || g || '@example.com' FROM generate_series(1, 1001) g`, ws.ID)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{}, "delete": true}).Want(t, 422)
	if n := count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, ws.ID); n != 1001 {
		t.Fatalf("a refused selection deleted %d", 1001-n)
	}
	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = ids.New().String()
	}
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": tooMany, "delete": true}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{"q": "p1000"}, "delete": true}).Want(t, 200)
	if n := count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, ws.ID); n != 1000 {
		t.Fatalf("%d left", n)
	}
}

// A search selects what the People list finds for it, extra addresses included.
func TestBulkContactsByExtraAddress(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var ann, bob withEmails
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "ann@work.example", "name": "Ann"}).Want(t, 201).JSON(t, &ann)
	e.Do("POST", "/v1/contacts/"+ann.ID+"/emails", a, map[string]any{"email": "ann@home.example"}).Want(t, 201)
	e.Do("POST", "/v1/contacts", a, map[string]any{"email": "bob@work.example", "name": "Bob"}).Want(t, 201).JSON(t, &bob)

	var list struct {
		Data []withEmails `json:"data"`
	}
	e.Do("GET", "/v1/contacts?q=ann@home", a, nil).Want(t, 200).JSON(t, &list)
	if len(list.Data) != 1 || list.Data[0].ID != ann.ID {
		t.Fatalf("list found %+v", list.Data)
	}
	var out bulkOut
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{"q": "ann@home"}, "delete": true}).Want(t, 200).JSON(t, &out)
	if out.Deleted != 1 {
		t.Fatalf("bulk by an extra address deleted %d", out.Deleted)
	}
	if count(e, `SELECT count(*) FROM contacts WHERE id = $1`, ann.ID) != 0 || count(e, `SELECT count(*) FROM contacts WHERE id = $1`, bob.ID) != 1 {
		t.Fatal("bulk by an extra address deleted the wrong contact")
	}
}

func TestBulkCompanies(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	var cs []string
	for _, n := range []string{"Acme", "Apex", "Zed"} {
		id := ids.New()
		e.Exec(`INSERT INTO companies (id, workspace_id, name) VALUES ($1, $2, $3)`, id, ws.ID, n)
		cs = append(cs, id.String())
	}
	var out bulkOut
	e.Do("POST", "/v1/companies/bulk", a, map[string]any{"ids": cs, "patch": map[string]any{"add_tags": []string{"partner"}}}).Want(t, 200).JSON(t, &out)
	if out.Updated != 3 {
		t.Fatalf("%+v", out)
	}
	// Two of them are Ac*/Ap*: found by the list's search, deleted together.
	e.Do("POST", "/v1/companies/bulk", a, map[string]any{"query": map[string]any{"q": "a", "tag": "partner"}, "delete": true}).Want(t, 200).JSON(t, &out)
	if out.Deleted != 2 {
		t.Fatalf("%+v", out)
	}
	var left []string
	rows, err := e.D.DB.Pool.Query(e.Ctx, `SELECT name FROM companies WHERE workspace_id = $1`, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		left = append(left, n)
	}
	if !slices.Equal(left, []string{"Zed"}) {
		t.Fatalf("left %v", left)
	}
	e.Do("POST", "/v1/companies/bulk", ws.Viewer.As(ws), map[string]any{"ids": cs, "delete": true}).Want(t, 403)
	e.Do("POST", "/v1/companies/bulk", a, map[string]any{"ids": []string{ids.New().String()}, "delete": true}).Want(t, 404)
}

// A custom field is set and cleared in bulk, and a field filter selects the records.
func TestBulkFields(t *testing.T) {
	e := hdtest.New(t, contacts.Register)
	ws := e.NewWorkspace()
	a := ws.Agent.As(ws)
	e.Exec(`INSERT INTO custom_fields (workspace_id, entity, key, name, type) VALUES ($1, 'contact', 'segment', 'Segment', 'text'),
		($1, 'company', 'seats', 'Seats', 'number')`, ws.ID)
	var people []string
	for i := range 4 {
		id := ids.New()
		e.Exec(`INSERT INTO contacts (id, workspace_id, name, email) VALUES ($1, $2, $3, $4)`, id, ws.ID, fmt.Sprintf("p%d", i), fmt.Sprintf("p%d@example.com", i))
		people = append(people, id.String())
	}
	segment := func(v string) int {
		return count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1 AND fields->>'segment' = $2`, ws.ID, v)
	}

	var out bulkOut
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:3], "patch": map[string]any{"fields": map[string]any{"segment": "Enterprise"}}}).Want(t, 200).JSON(t, &out)
	if out.Updated != 3 || segment("Enterprise") != 3 {
		t.Fatalf("set %+v, %d", out, segment("Enterprise"))
	}
	// The list's field filter is the selection.
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{"fields": []map[string]any{{"key": "segment", "op": "eq", "value": "Enterprise"}}},
		"patch": map[string]any{"add_tags": []string{"big"}}}).Want(t, 200).JSON(t, &out)
	if out.Updated != 3 {
		t.Fatalf("by field %+v", out)
	}
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people[:1], "patch": map[string]any{"fields": map[string]any{"segment": nil}}}).Want(t, 200)
	if segment("Enterprise") != 2 || count(e, `SELECT count(*) FROM contacts WHERE id = $1 AND fields ? 'segment'`, people[0]) != 0 {
		t.Fatal("not cleared")
	}

	// Refusals change nothing: a field of companies, an unknown one, a field filter that is not one, an empty patch.
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people, "patch": map[string]any{"fields": map[string]any{"seats": 3}, "add_tags": []string{"x"}}}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people, "patch": map[string]any{"fields": map[string]any{"nope": "x"}}}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"query": map[string]any{"fields": []map[string]any{{"key": "nope", "op": "eq", "value": "x"}}}, "delete": true}).Want(t, 422)
	e.Do("POST", "/v1/contacts/bulk", a, map[string]any{"ids": people, "patch": map[string]any{}}).Want(t, 422)
	if count(e, `SELECT count(*) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.workspace_id = $1 AND t.name = 'x'`, ws.ID) != 0 ||
		count(e, `SELECT count(*) FROM contacts WHERE workspace_id = $1`, ws.ID) != 4 {
		t.Fatal("a refused request changed contacts")
	}
	// Each record is audited and announced.
	if n := count(e, `SELECT count(*) FROM audit_logs WHERE workspace_id = $1 AND action = 'contact.updated' AND data->>'bulk' = 'true'`, ws.ID); n != 7 {
		t.Fatalf("%d updates audited", n)
	}
	if n := count(e, `SELECT count(*) FROM events WHERE workspace_id = $1 AND type = 'contact.updated'`, ws.ID); n != 7 {
		t.Fatalf("%d updates announced", n)
	}

	// Companies: a number set by filter, then cleared.
	for _, n := range []string{"Acme", "Apex"} {
		e.Exec(`INSERT INTO companies (id, workspace_id, name) VALUES ($1, $2, $3)`, ids.New(), ws.ID, n)
	}
	e.Do("POST", "/v1/companies/bulk", a, map[string]any{"query": map[string]any{"q": "acme"}, "patch": map[string]any{"fields": map[string]any{"seats": 40}}}).Want(t, 200).JSON(t, &out)
	if out.Updated != 1 || count(e, `SELECT count(*) FROM companies WHERE workspace_id = $1 AND fields->>'seats' = '40'`, ws.ID) != 1 {
		t.Fatalf("company field %+v", out)
	}
	e.Do("POST", "/v1/companies/bulk", a, map[string]any{"query": map[string]any{"fields": []map[string]any{{"key": "seats", "op": "set", "value": ""}}}, "delete": true}).Want(t, 200).JSON(t, &out)
	if out.Deleted != 1 || count(e, `SELECT count(*) FROM companies WHERE workspace_id = $1`, ws.ID) != 1 {
		t.Fatalf("company delete by field %+v", out)
	}
	e.Do("POST", "/v1/companies/bulk", a, map[string]any{"query": map[string]any{}, "patch": map[string]any{"fields": map[string]any{"seats": "many"}}}).Want(t, 422)
}
