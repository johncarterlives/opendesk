package mcpserver

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/auth"
)

type contactOut struct {
	Contact struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		Email      string   `json:"email"`
		Phone      string   `json:"phone"`
		ExternalID string   `json:"external_id"`
		Labels     []string `json:"labels"`
		Notes      string   `json:"notes"`
		Company    *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"company"`
	} `json:"contact"`
	Created bool `json:"created"`
}

type companyOut struct {
	Company struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		Domain     string   `json:"domain"`
		ExternalID string   `json:"external_id"`
		Labels     []string `json:"labels"`
	} `json:"company"`
	Created bool `json:"created"`
}

// errorBody is a tool error's JSON.
func errorBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var b map[string]any
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		t.Fatalf("error body %q: %v", raw, err)
	}
	return b
}

// A client can keep contacts and companies in step with another system: create them with
// that system's ids, find them again by those ids, and update them without losing what it
// did not send.
func TestContactAndCompanySync(t *testing.T) {
	e := newEnv(t)
	s := e.session(e.APIKey(e.WS, auth.ScopeContactsRead, auth.ScopeContactsWrite, auth.ScopeTicketsRead))

	var co companyOut
	call(t, s, "create_company", map[string]any{"name": "Skeps", "domain": "skeps.example", "external_id": "crm-co-1", "labels": []string{"customer"}}, &co)
	if !co.Created || co.Company.ID == "" || co.Company.ExternalID != "crm-co-1" || !slices.Contains(co.Company.Labels, "customer") {
		t.Fatalf("create_company: %+v", co)
	}

	// A person linked to the company by its name.
	var ct contactOut
	call(t, s, "create_contact", map[string]any{"email": "sander@skeps.example", "name": "Sander", "phone": "+31 20 000 0000",
		"company": "skeps", "external_id": "crm-p-7", "labels": []string{"vip"}, "notes": "Signed the quote."}, &ct)
	if !ct.Created || ct.Contact.Company == nil || ct.Contact.Company.ID != co.Company.ID || ct.Contact.ExternalID != "crm-p-7" ||
		ct.Contact.Phone != "+31 20 000 0000" || ct.Contact.Notes != "Signed the quote." {
		t.Fatalf("create_contact: %+v", ct)
	}

	// The same address again is refused with the contact that has it.
	res := call(t, s, "create_contact", map[string]any{"email": "SANDER@skeps.example", "name": "Someone else"}, nil)
	if !res.IsError {
		t.Fatalf("duplicate email created: %s", text(res))
	}
	b := errorBody(t, text(res))
	existing, _ := b["existing"].(map[string]any)
	if b["code"] != "already_exists" || existing["id"] != ct.Contact.ID {
		t.Fatalf("duplicate: %s", text(res))
	}

	// if_exists update changes it instead, adding labels and keeping the others.
	var up contactOut
	call(t, s, "create_contact", map[string]any{"external_id": "crm-p-7", "name": "Sander Terpstra", "labels": []string{"beta"},
		"if_exists": "update"}, &up)
	if up.Created || up.Contact.ID != ct.Contact.ID || up.Contact.Name != "Sander Terpstra" ||
		!slices.Contains(up.Contact.Labels, "vip") || !slices.Contains(up.Contact.Labels, "beta") {
		t.Fatalf("upsert: %+v", up)
	}

	// Found again by external id, by email and by id.
	for _, ref := range []string{"crm-p-7", "sander@skeps.example", ct.Contact.ID} {
		var got contactOut
		call(t, s, "get_contact", map[string]any{"contact": ref}, &got)
		if got.Contact.ID != ct.Contact.ID {
			t.Fatalf("get_contact %q: %+v", ref, got)
		}
	}

	// Updates change only what they name.
	up = contactOut{}
	call(t, s, "update_contact", map[string]any{"contact": "crm-p-7", "phone": "", "remove_labels": []string{"beta"}}, &up)
	if up.Contact.Phone != "" || slices.Contains(up.Contact.Labels, "beta") || !slices.Contains(up.Contact.Labels, "vip") ||
		up.Contact.Company == nil || up.Contact.Notes != "Signed the quote." {
		t.Fatalf("update_contact: %+v", up)
	}
	up = contactOut{}
	call(t, s, "update_contact", map[string]any{"contact": ct.Contact.ID, "company": "none"}, &up)
	if up.Contact.Company != nil {
		t.Fatalf("company not removed: %+v", up)
	}
	call(t, s, "update_contact", map[string]any{"contact": ct.Contact.ID, "company": "crm-co-1"}, &up)
	if up.Contact.Company == nil || up.Contact.Company.ID != co.Company.ID {
		t.Fatalf("company by external id: %+v", up)
	}

	// The company is found by its domain, with its people.
	var one struct {
		Company struct {
			ID string `json:"id"`
		} `json:"company"`
		Contacts []struct {
			ID string `json:"id"`
		} `json:"contacts"`
	}
	call(t, s, "get_company", map[string]any{"company": "skeps.example"}, &one)
	if one.Company.ID != co.Company.ID || len(one.Contacts) != 1 || one.Contacts[0].ID != ct.Contact.ID {
		t.Fatalf("get_company: %+v", one)
	}
	var people struct {
		Contacts []struct {
			ID string `json:"id"`
		} `json:"contacts"`
	}
	call(t, s, "search_contacts", map[string]any{"company": co.Company.ID}, &people)
	if len(people.Contacts) != 1 {
		t.Fatalf("search_contacts by company: %+v", people)
	}
	call(t, s, "search_contacts", map[string]any{"external_id": "crm-p-7"}, &people)
	if len(people.Contacts) != 1 || people.Contacts[0].ID != ct.Contact.ID {
		t.Fatalf("search_contacts by external_id: %+v", people)
	}
	var cos struct {
		Companies []struct {
			ID string `json:"id"`
		} `json:"companies"`
	}
	call(t, s, "search_companies", map[string]any{"external_id": "crm-co-1"}, &cos)
	if len(cos.Companies) != 1 {
		t.Fatalf("search_companies by external_id: %+v", cos)
	}

	// A taken domain is refused with the company, or updated with if_exists update.
	res = call(t, s, "create_company", map[string]any{"name": "Skeps BV", "domain": "skeps.example"}, nil)
	if b := errorBody(t, text(res)); !res.IsError || b["code"] != "already_exists" {
		t.Fatalf("duplicate domain: %s", text(res))
	}
	// The same domain written another way is the same company.
	var again companyOut
	call(t, s, "create_company", map[string]any{"name": "Skeps", "domain": "https://www.SKEPS.example/", "if_exists": "update"}, &again)
	if again.Created || again.Company.ID != co.Company.ID {
		t.Fatalf("upsert by domain: %+v", again)
	}
	co = companyOut{}
	call(t, s, "update_company", map[string]any{"company": "crm-co-1", "name": "Skeps BV", "add_labels": []string{"partner"}}, &co)
	if co.Company.Name != "Skeps BV" || !slices.Contains(co.Company.Labels, "customer") || !slices.Contains(co.Company.Labels, "partner") {
		t.Fatalf("update_company: %+v", co)
	}

	// A name two companies share is refused, naming both.
	call(t, s, "create_company", map[string]any{"name": "Twin"}, nil)
	call(t, s, "create_company", map[string]any{"name": "twin"}, nil)
	res = call(t, s, "update_contact", map[string]any{"contact": ct.Contact.ID, "company": "Twin"}, nil)
	if !res.IsError || !strings.Contains(text(res), "2 companies") {
		t.Fatalf("ambiguous company: %s", text(res))
	}

	// Writes are announced like the API's.
	types, _ := e.Events(e.WS.ID, 0)
	for _, want := range []string{"contact.created", "contact.updated", "company.created", "company.updated"} {
		if !slices.Contains(types, want) {
			t.Fatalf("events: %v lack %s", types, want)
		}
	}

	// A read-only key gets no write tools.
	ro := toolNames(t, e.session(e.APIKey(e.WS, auth.ScopeContactsRead)))
	if slices.Contains(ro, "create_contact") || slices.Contains(ro, "update_company") || slices.Contains(ro, "api_write") {
		t.Fatalf("read-only tools: %v", ro)
	}
}
