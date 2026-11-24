package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/domain"
)

// --- contacts and companies ------------------------------------------------------------

const (
	contactArg  = "The contact: their id, their email address (primary or extra), or the external_id your own system gave them."
	companyArg  = "The company: its id, its external_id, its domain or its exact name."
	ifExistsArg = "What to do when a contact or company with the same email, domain or external_id already exists: " +
		"error (default) returns it in the error as existing, update changes it with the values given here (labels are added, fields merged)."
)

func contactTools() []*tool {
	read, write := []string{auth.ScopeContactsRead}, []string{auth.ScopeContactsWrite}
	contactProps := map[string]any{
		"email":       strN("Primary email address. An empty string clears it.", 0, 254),
		"name":        strN("Full name.", 1, 200),
		"phone":       strN("Phone number. An empty string clears it.", 0, 50),
		"company":     str(`The company: its id, external_id, domain or exact name (find or create it with search_companies and create_company first). "none" removes the contact from their company.`),
		"external_id": strN("Your own system's id for this person, unique in the workspace; use it to find them again when you sync. An empty string clears it.", 0, 200),
		"notes":       strN("Notes about the contact, replacing the current notes. An empty string clears them.", 0, 10000),
		"fields":      fieldsArg("Custom field values, by key; the others keep theirs. null clears a field.", domain.FieldEntityContact),
	}
	companyProps := map[string]any{
		"name":        strN("The company's name.", 1, 200),
		"domain":      strN("Its web domain, such as example.com. An empty string clears it.", 0, 253),
		"external_id": strN("Your own system's id for this company, unique in the workspace; use it to find it again when you sync. An empty string clears it.", 0, 200),
		"notes":       strN("Notes about the company, replacing the current notes. An empty string clears them.", 0, 10000),
		"fields":      fieldsArg("Custom field values, by key; the others keep theirs. null clears a field.", domain.FieldEntityCompany),
	}
	labels := arr("Label names to add.", strN("", 1, 50), 50)
	unlabels := arr("Label names to remove.", strN("", 1, 50), 50)
	return []*tool{
		{
			Name: "search_contacts", Title: "Search contacts", Scopes: read, ReadOnly: true, Idempotent: true,
			Description: "Find customers (contacts) by name, email, phone or custom field value, or by company, label or external_id. " +
				"Without a query, lists the newest contacts.",
			Schema: obj(map[string]any{
				"query":       strN("What to search for: a name, an email or part of one, a phone number or a field value.", 1, 200),
				"company":     str(companyArg + ` "none" lists people without a company.`),
				"label":       strN("Only contacts with this label.", 1, 50),
				"external_id": strN("Only the contact with this external_id, matched exactly.", 1, 200),
				"limit":       integer("How many contacts to return.", 1, 50, 10),
				"cursor":      str("next_cursor from a previous search, for the next page."),
			}),
			Run: searchContacts,
		},
		{
			Name: "get_contact", Title: "Get a contact", Scopes: read, ReadOnly: true, Idempotent: true,
			Description: "Read one contact by id, email or external_id: details, extra addresses, company, labels, custom fields and notes, " +
				"plus their latest tickets when the connection can read tickets.",
			Schema: obj(map[string]any{"contact": str(contactArg)}, "contact"),
			Run:    getContact,
		},
		{
			Name: "create_contact", Title: "Create a contact", Scopes: write,
			Description: "Create a customer (contact) with an email address, a name or both, and optionally a phone number, company, external_id, " +
				"labels, notes and custom fields (keys from list_custom_fields with entity contact). An email or external_id another contact has " +
				"is refused with that contact as existing, unless if_exists is update. Nothing is sent to the contact.",
			Schema: obj(merge(contactProps, map[string]any{"labels": labels, "if_exists": enum(ifExistsArg, "error", "update")})),
			Run:    createContact,
		},
		{
			Name: "update_contact", Title: "Update a contact", Scopes: write, Destructive: true, Idempotent: true,
			Description: "Change a contact's email, name, phone, company, external_id, labels, notes or custom fields. Only the arguments you pass change: " +
				"labels are added and removed by name and fields are merged, so nothing you leave out is lost. Returns the updated contact.",
			Schema: obj(merge(contactProps, map[string]any{"contact": str(contactArg), "add_labels": labels, "remove_labels": unlabels}), "contact"),
			Run:    updateContact,
		},
		{
			Name: "search_companies", Title: "Search companies", Scopes: read, ReadOnly: true, Idempotent: true,
			Description: "Find companies by name, domain or custom field value, or by label or external_id. Without a query, lists them by name.",
			Schema: obj(map[string]any{
				"query":       strN("A name, a domain or part of one, or a field value.", 1, 200),
				"label":       strN("Only companies with this label.", 1, 50),
				"external_id": strN("Only the company with this external_id, matched exactly.", 1, 200),
				"limit":       integer("How many companies to return.", 1, 50, 10),
				"cursor":      str("next_cursor from a previous search, for the next page."),
			}),
			Run: searchCompanies,
		},
		{
			Name: "get_company", Title: "Get a company", Scopes: read, ReadOnly: true, Idempotent: true,
			Description: "Read one company by id, external_id, domain or name: details, labels, custom fields, notes and its first 25 people.",
			Schema:      obj(map[string]any{"company": str(companyArg)}, "company"),
			Run:         getCompany,
		},
		{
			Name: "create_company", Title: "Create a company", Scopes: write,
			Description: "Create a company with a name, and optionally a domain, external_id, labels, notes and custom fields (keys from list_custom_fields " +
				"with entity company). A domain or external_id another company has is refused with that company as existing, unless if_exists is update. " +
				"Link people to it with create_contact or update_contact.",
			Schema: obj(merge(companyProps, map[string]any{"labels": labels, "if_exists": enum(ifExistsArg, "error", "update")}), "name"),
			Run:    createCompany,
		},
		{
			Name: "update_company", Title: "Update a company", Scopes: write, Destructive: true, Idempotent: true,
			Description: "Change a company's name, domain, external_id, labels, notes or custom fields. Only the arguments you pass change: " +
				"labels are added and removed by name and fields are merged. Returns the updated company.",
			Schema: obj(merge(companyProps, map[string]any{"company": str(companyArg), "add_labels": labels, "remove_labels": unlabels}), "company"),
			Run:    updateCompany,
		},
	}
}

func merge(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// --- API shapes and outputs ------------------------------------------------------------

type apiContact struct {
	ID      string   `json:"id"`
	Email   *string  `json:"email"`
	Emails  []string `json:"emails"`
	Name    string   `json:"name"`
	Phone   string   `json:"phone"`
	Company *struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Domain string `json:"domain"`
	} `json:"company"`
	ExternalID  *string        `json:"external_id"`
	Notes       string         `json:"notes"`
	Tags        []tagRef       `json:"tags"`
	Fields      map[string]any `json:"fields"`
	Blocked     bool           `json:"blocked"`
	TicketCount int            `json:"ticket_count"`
	CreatedAt   time.Time      `json:"created_at"`
}

type apiCompany struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Domain       string         `json:"domain"`
	ExternalID   *string        `json:"external_id"`
	Notes        string         `json:"notes"`
	Tags         []tagRef       `json:"tags"`
	Fields       map[string]any `json:"fields"`
	ContactCount int            `json:"contact_count"`
	CreatedAt    time.Time      `json:"created_at"`
}

type outCompany struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Domain       string         `json:"domain,omitempty"`
	ExternalID   string         `json:"external_id,omitempty"`
	Labels       []string       `json:"labels,omitempty"`
	Fields       map[string]any `json:"fields,omitempty"`
	Notes        string         `json:"notes,omitempty"`
	ContactCount *int           `json:"contact_count,omitempty"`
	CreatedAt    *time.Time     `json:"created_at,omitempty"`
}

type outContact struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Email       string         `json:"email,omitempty"`
	Emails      []string       `json:"other_emails,omitempty"`
	Phone       string         `json:"phone,omitempty"`
	Company     *outCompany    `json:"company,omitempty"`
	ExternalID  string         `json:"external_id,omitempty"`
	Labels      []string       `json:"labels,omitempty"`
	Fields      map[string]any `json:"fields,omitempty"`
	Notes       string         `json:"notes,omitempty"`
	Blocked     bool           `json:"blocked,omitempty"`
	TicketCount int            `json:"ticket_count"`
	CreatedAt   time.Time      `json:"created_at"`
}

func labelNames(tags []tagRef) []string {
	var out []string
	for _, t := range tags {
		out = append(out, t.Name)
	}
	return out
}

func compactContact(c apiContact, full bool) outContact {
	o := outContact{ID: c.ID, Name: c.Name, Phone: c.Phone, Blocked: c.Blocked, TicketCount: c.TicketCount, CreatedAt: c.CreatedAt,
		Labels: labelNames(c.Tags)}
	if c.Email != nil {
		o.Email = *c.Email
	}
	if c.Company != nil {
		o.Company = &outCompany{ID: c.Company.ID, Name: c.Company.Name, Domain: c.Company.Domain}
	}
	if c.ExternalID != nil {
		o.ExternalID = *c.ExternalID
	}
	if full {
		o.Emails = c.Emails
		if len(c.Fields) > 0 {
			o.Fields = c.Fields
		}
		o.Notes = clip(c.Notes, 2000)
	}
	return o
}

func compactCompany(c apiCompany, full bool) outCompany {
	n, at := c.ContactCount, c.CreatedAt
	o := outCompany{ID: c.ID, Name: c.Name, Domain: c.Domain, Labels: labelNames(c.Tags), ContactCount: &n, CreatedAt: &at}
	if c.ExternalID != nil {
		o.ExternalID = *c.ExternalID
	}
	if full {
		if len(c.Fields) > 0 {
			o.Fields = c.Fields
		}
		o.Notes = clip(c.Notes, 2000)
	}
	return o
}

// errExists is a create refused because the record is already there; the client gets
// that record so it can update it instead.
type errExists struct {
	msg      string
	existing any
}

func (e *errExists) Error() string { return e.msg }

// --- contacts --------------------------------------------------------------------------

func searchContacts(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Query      string `json:"query"`
		Company    string `json:"company"`
		Label      string `json:"label"`
		ExternalID string `json:"external_id"`
		Limit      int    `json:"limit"`
		Cursor     string `json:"cursor"`
	}](raw)
	if err != nil {
		return nil, err
	}
	q := listQuery(a.Query, a.Label, a.ExternalID, a.Limit, a.Cursor)
	if v := strings.TrimSpace(a.Company); v != "" {
		if strings.EqualFold(v, "none") {
			q.Set("company_id", "none")
		} else {
			co, err := findCompany(ctx, c, v)
			if err != nil {
				return nil, err
			}
			q.Set("company_id", co.ID)
		}
	}
	var pg page[apiContact]
	if err := c.get(ctx, "/v1/contacts", q, &pg); err != nil {
		return nil, err
	}
	out := struct {
		Contacts   []outContact `json:"contacts"`
		Count      int          `json:"count"`
		NextCursor *string      `json:"next_cursor,omitempty"`
	}{Contacts: []outContact{}, NextCursor: pg.NextCursor}
	for _, ct := range pg.Data {
		out.Contacts = append(out.Contacts, compactContact(ct, false))
	}
	out.Count = len(out.Contacts)
	return out, nil
}

// listQuery is a contact or company list's query from a tool's search arguments.
func listQuery(query, label, externalID string, limit int, cursor string) url.Values {
	if limit <= 0 {
		limit = 10
	}
	q := url.Values{"limit": {strconv.Itoa(min(limit, 50))}}
	if s := strings.TrimSpace(query); s != "" {
		q.Set("q", clip(s, 200))
	}
	if s := strings.TrimSpace(label); s != "" {
		q.Set("tag", s)
	}
	if s := strings.TrimSpace(externalID); s != "" {
		q.Set("external_id", s)
	}
	if s := strings.TrimSpace(cursor); s != "" {
		q.Set("cursor", s)
	}
	return q
}

func getContact(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Contact string `json:"contact"`
	}](raw)
	if err != nil {
		return nil, err
	}
	ct, err := findContact(ctx, c, a.Contact)
	if err != nil {
		return nil, err
	}
	out := struct {
		Contact outContact  `json:"contact"`
		Tickets []outTicket `json:"recent_tickets,omitempty"`
	}{Contact: compactContact(ct, true)}
	if c.p.HasScope(auth.ScopeTicketsRead) {
		var pg page[apiTicket]
		if err := c.get(ctx, "/v1/contacts/"+ct.ID+"/tickets", url.Values{"limit": {"10"}}, &pg); err == nil {
			for _, t := range pg.Data {
				out.Tickets = append(out.Tickets, compactTicket(t, false))
			}
			c.nameAll(ctx, out.Tickets)
		}
	}
	return out, nil
}

// findContact resolves a contact reference: an id, an email address (primary or extra),
// or an external_id. An id or address that matches nothing is tried as an external_id,
// since another system's ids can look like either.
func findContact(ctx context.Context, c *caller, ref string) (apiContact, error) {
	v := strings.TrimSpace(ref)
	if v == "" || utf8.RuneCountInString(v) > 254 {
		return apiContact{}, invalid("contact must be an id, an email address or an external_id")
	}
	if id, err := uuid.Parse(v); err == nil {
		var ct apiContact
		err := c.get(ctx, "/v1/contacts/"+id.String(), nil, &ct)
		if statusOf(err) != http.StatusNotFound {
			return ct, err
		}
	} else if strings.Contains(v, "@") {
		if ct, ok, err := contactByEmail(ctx, c, v); err != nil || ok {
			return ct, err
		}
	}
	if ct, ok, err := contactByExternalID(ctx, c, v); err != nil || ok {
		return ct, err
	}
	return apiContact{}, invalid("no contact has the id, email or external_id " + strconv.Quote(clip(v, 100)))
}

func contactByEmail(ctx context.Context, c *caller, email string) (apiContact, bool, error) {
	var pg page[apiContact]
	if err := c.get(ctx, "/v1/contacts", url.Values{"q": {email}, "limit": {"20"}}, &pg); err != nil {
		return apiContact{}, false, err
	}
	for _, ct := range pg.Data {
		if ct.Email != nil && strings.EqualFold(*ct.Email, email) {
			return ct, true, nil
		}
		for _, e := range ct.Emails {
			if strings.EqualFold(e, email) {
				return ct, true, nil
			}
		}
	}
	return apiContact{}, false, nil
}

func contactByExternalID(ctx context.Context, c *caller, ext string) (apiContact, bool, error) {
	if utf8.RuneCountInString(ext) > 200 {
		return apiContact{}, false, nil
	}
	var pg page[apiContact]
	if err := c.get(ctx, "/v1/contacts", url.Values{"external_id": {ext}, "limit": {"1"}}, &pg); err != nil {
		return apiContact{}, false, err
	}
	if len(pg.Data) == 0 {
		return apiContact{}, false, nil
	}
	return pg.Data[0], true, nil
}

type contactArgs struct {
	Email        *string        `json:"email"`
	Name         string         `json:"name"`
	Phone        *string        `json:"phone"`
	Company      string         `json:"company"`
	ExternalID   *string        `json:"external_id"`
	Notes        *string        `json:"notes"`
	Fields       map[string]any `json:"fields"`
	Labels       []string       `json:"labels"`
	AddLabels    []string       `json:"add_labels"`
	RemoveLabels []string       `json:"remove_labels"`
	IfExists     string         `json:"if_exists"`
	Contact      string         `json:"contact"`
}

// body is the API write body of a contact tool's arguments. Labels always go as
// add_tags and remove_tags, so a write never drops labels it did not name.
func (a contactArgs) body(ctx context.Context, c *caller) (map[string]any, error) {
	b := map[string]any{}
	if a.Email != nil {
		b["email"] = strings.TrimSpace(*a.Email)
	}
	if n := strings.TrimSpace(a.Name); n != "" {
		b["name"] = n
	}
	if a.Phone != nil {
		b["phone"] = strings.TrimSpace(*a.Phone)
	}
	if a.ExternalID != nil {
		b["external_id"] = strings.TrimSpace(*a.ExternalID)
	}
	if a.Notes != nil {
		b["notes"] = *a.Notes
	}
	if v := strings.TrimSpace(a.Company); v != "" {
		if strings.EqualFold(v, "none") {
			b["company_id"] = nil
		} else {
			co, err := findCompany(ctx, c, v)
			if err != nil {
				return nil, err
			}
			b["company_id"] = co.ID
		}
	}
	if len(a.Fields) > 0 {
		b["fields"] = a.Fields
	}
	if err := labelChanges(b, append(a.Labels, a.AddLabels...), a.RemoveLabels); err != nil {
		return nil, err
	}
	return b, nil
}

func labelChanges(b map[string]any, add, remove []string) error {
	add, err := cleanLabels(add)
	if err != nil {
		return err
	}
	remove, err = cleanLabels(remove)
	if err != nil {
		return err
	}
	if len(add) > 0 {
		b["add_tags"] = add
	}
	if len(remove) > 0 {
		b["remove_tags"] = remove
	}
	return nil
}

type contactWritten struct {
	Contact outContact `json:"contact"`
	Created bool       `json:"created"`
}

func createContact(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[contactArgs](raw)
	if err != nil {
		return nil, err
	}
	if a.Contact != "" || len(a.AddLabels) > 0 || len(a.RemoveLabels) > 0 {
		return nil, invalid("create_contact takes labels; contact, add_labels and remove_labels are update_contact's")
	}
	if err := oneOf(a.IfExists, "if_exists", "error", "update"); err != nil {
		return nil, err
	}
	if (a.Email == nil || strings.TrimSpace(*a.Email) == "") && strings.TrimSpace(a.Name) == "" {
		return nil, invalid("a contact needs an email address or a name")
	}
	b, err := a.body(ctx, c)
	if err != nil {
		return nil, err
	}
	var ct apiContact
	err = c.do(ctx, http.MethodPost, "/v1/contacts", nil, b, &ct)
	if statusOf(err) == http.StatusConflict {
		existing, ok, ferr := existingContact(ctx, c, a)
		if ferr != nil || !ok {
			return nil, err
		}
		if a.IfExists != "update" {
			return nil, &errExists{msg: err.Error() + " Update it with update_contact, or pass if_exists update.", existing: compactContact(existing, true)}
		}
		if err := c.do(ctx, http.MethodPatch, "/v1/contacts/"+existing.ID, nil, b, &ct); err != nil {
			return nil, err
		}
		return contactWritten{Contact: compactContact(ct, true)}, nil
	}
	if err != nil {
		return nil, err
	}
	return contactWritten{Contact: compactContact(ct, true), Created: true}, nil
}

// existingContact is the contact a create collided with: the one with its email, else
// the one with its external_id.
func existingContact(ctx context.Context, c *caller, a contactArgs) (apiContact, bool, error) {
	if a.Email != nil && strings.TrimSpace(*a.Email) != "" {
		if ct, ok, err := contactByEmail(ctx, c, strings.TrimSpace(*a.Email)); err != nil || ok {
			return ct, ok, err
		}
	}
	if a.ExternalID != nil && strings.TrimSpace(*a.ExternalID) != "" {
		return contactByExternalID(ctx, c, strings.TrimSpace(*a.ExternalID))
	}
	return apiContact{}, false, nil
}

func updateContact(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[contactArgs](raw)
	if err != nil {
		return nil, err
	}
	if len(a.Labels) > 0 || a.IfExists != "" {
		return nil, invalid("update_contact takes add_labels and remove_labels; labels and if_exists are create_contact's")
	}
	ct, err := findContact(ctx, c, a.Contact)
	if err != nil {
		return nil, err
	}
	b, err := a.body(ctx, c)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, invalid("nothing to change: pass at least one value to set")
	}
	var updated apiContact
	if err := c.do(ctx, http.MethodPatch, "/v1/contacts/"+ct.ID, nil, b, &updated); err != nil {
		return nil, err
	}
	return contactWritten{Contact: compactContact(updated, true)}, nil
}

// --- companies -------------------------------------------------------------------------

func searchCompanies(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Query      string `json:"query"`
		Label      string `json:"label"`
		ExternalID string `json:"external_id"`
		Limit      int    `json:"limit"`
		Cursor     string `json:"cursor"`
	}](raw)
	if err != nil {
		return nil, err
	}
	var pg page[apiCompany]
	if err := c.get(ctx, "/v1/companies", listQuery(a.Query, a.Label, a.ExternalID, a.Limit, a.Cursor), &pg); err != nil {
		return nil, err
	}
	out := struct {
		Companies  []outCompany `json:"companies"`
		Count      int          `json:"count"`
		NextCursor *string      `json:"next_cursor,omitempty"`
	}{Companies: []outCompany{}, NextCursor: pg.NextCursor}
	for _, co := range pg.Data {
		out.Companies = append(out.Companies, compactCompany(co, false))
	}
	out.Count = len(out.Companies)
	return out, nil
}

func getCompany(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Company string `json:"company"`
	}](raw)
	if err != nil {
		return nil, err
	}
	co, err := findCompany(ctx, c, a.Company)
	if err != nil {
		return nil, err
	}
	var pg page[apiContact]
	if err := c.get(ctx, "/v1/contacts", url.Values{"company_id": {co.ID}, "limit": {"25"}, "sort": {"name"}}, &pg); err != nil {
		return nil, err
	}
	out := struct {
		Company  outCompany   `json:"company"`
		Contacts []outContact `json:"contacts"`
		More     bool         `json:"more_contacts,omitempty"`
	}{Company: compactCompany(co, true), Contacts: []outContact{}, More: pg.NextCursor != nil}
	for _, ct := range pg.Data {
		o := compactContact(ct, false)
		o.Company = nil
		out.Contacts = append(out.Contacts, o)
	}
	return out, nil
}

// findCompany resolves a company reference: an id, an external_id, a domain or an exact
// name (case-insensitive). A name that several companies share is refused.
func findCompany(ctx context.Context, c *caller, ref string) (apiCompany, error) {
	v := strings.TrimSpace(ref)
	if v == "" || utf8.RuneCountInString(v) > 253 {
		return apiCompany{}, invalid("company must be an id, an external_id, a domain or a name")
	}
	if id, err := uuid.Parse(v); err == nil {
		var co apiCompany
		err := c.get(ctx, "/v1/companies/"+id.String(), nil, &co)
		if statusOf(err) != http.StatusNotFound {
			return co, err
		}
	}
	if co, ok, err := companyByExternalID(ctx, c, v); err != nil || ok {
		return co, err
	}
	if co, ok, err := companyByDomain(ctx, c, v); err != nil || ok {
		return co, err
	}
	var pg page[apiCompany]
	if err := c.get(ctx, "/v1/companies", url.Values{"q": {v}, "limit": {"50"}}, &pg); err != nil {
		return apiCompany{}, err
	}
	var named []apiCompany
	for _, co := range pg.Data {
		if strings.EqualFold(co.Name, v) {
			named = append(named, co)
		}
	}
	switch len(named) {
	case 1:
		return named[0], nil
	case 0:
		return apiCompany{}, invalid("no company has the id, external_id, domain or name " + strconv.Quote(clip(v, 100)) +
			"; find it with search_companies or create it with create_company")
	}
	ids := make([]string, 0, len(named))
	for _, co := range named {
		ids = append(ids, co.ID)
	}
	return apiCompany{}, invalid(strconv.Itoa(len(named)) + " companies are named " + strconv.Quote(clip(v, 100)) +
		"; pass one's id instead: " + strings.Join(ids, ", "))
}

func companyByExternalID(ctx context.Context, c *caller, ext string) (apiCompany, bool, error) {
	if utf8.RuneCountInString(ext) > 200 {
		return apiCompany{}, false, nil
	}
	var pg page[apiCompany]
	if err := c.get(ctx, "/v1/companies", url.Values{"external_id": {ext}, "limit": {"1"}}, &pg); err != nil {
		return apiCompany{}, false, err
	}
	if len(pg.Data) == 0 {
		return apiCompany{}, false, nil
	}
	return pg.Data[0], true, nil
}

type companyArgs struct {
	Name         string         `json:"name"`
	Domain       *string        `json:"domain"`
	ExternalID   *string        `json:"external_id"`
	Notes        *string        `json:"notes"`
	Fields       map[string]any `json:"fields"`
	Labels       []string       `json:"labels"`
	AddLabels    []string       `json:"add_labels"`
	RemoveLabels []string       `json:"remove_labels"`
	IfExists     string         `json:"if_exists"`
	Company      string         `json:"company"`
}

func (a companyArgs) body() (map[string]any, error) {
	b := map[string]any{}
	if n := strings.TrimSpace(a.Name); n != "" {
		b["name"] = n
	}
	if a.Domain != nil {
		b["domain"] = strings.TrimSpace(*a.Domain)
	}
	if a.ExternalID != nil {
		b["external_id"] = strings.TrimSpace(*a.ExternalID)
	}
	if a.Notes != nil {
		b["notes"] = *a.Notes
	}
	if len(a.Fields) > 0 {
		b["fields"] = a.Fields
	}
	if err := labelChanges(b, append(a.Labels, a.AddLabels...), a.RemoveLabels); err != nil {
		return nil, err
	}
	return b, nil
}

type companyWritten struct {
	Company outCompany `json:"company"`
	Created bool       `json:"created"`
}

func createCompany(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[companyArgs](raw)
	if err != nil {
		return nil, err
	}
	if a.Company != "" || len(a.AddLabels) > 0 || len(a.RemoveLabels) > 0 {
		return nil, invalid("create_company takes labels; company, add_labels and remove_labels are update_company's")
	}
	if err := oneOf(a.IfExists, "if_exists", "error", "update"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Name) == "" {
		return nil, invalid("a company needs a name")
	}
	b, err := a.body()
	if err != nil {
		return nil, err
	}
	var co apiCompany
	err = c.do(ctx, http.MethodPost, "/v1/companies", nil, b, &co)
	if statusOf(err) == http.StatusConflict {
		existing, ok, ferr := existingCompany(ctx, c, a)
		if ferr != nil || !ok {
			return nil, err
		}
		if a.IfExists != "update" {
			return nil, &errExists{msg: err.Error() + " Update it with update_company, or pass if_exists update.", existing: compactCompany(existing, true)}
		}
		if err := c.do(ctx, http.MethodPatch, "/v1/companies/"+existing.ID, nil, b, &co); err != nil {
			return nil, err
		}
		return companyWritten{Company: compactCompany(co, true)}, nil
	}
	if err != nil {
		return nil, err
	}
	return companyWritten{Company: compactCompany(co, true), Created: true}, nil
}

// existingCompany is the company a create collided with: the one with its external_id,
// else the one with its domain.
func existingCompany(ctx context.Context, c *caller, a companyArgs) (apiCompany, bool, error) {
	if a.ExternalID != nil && strings.TrimSpace(*a.ExternalID) != "" {
		if co, ok, err := companyByExternalID(ctx, c, strings.TrimSpace(*a.ExternalID)); err != nil || ok {
			return co, ok, err
		}
	}
	if a.Domain == nil {
		return apiCompany{}, false, nil
	}
	return companyByDomain(ctx, c, *a.Domain)
}

// companyByDomain finds the company with a domain, written as the API stores it: lower
// case, without a scheme, "www." or a trailing slash.
func companyByDomain(ctx context.Context, c *caller, raw string) (apiCompany, bool, error) {
	d := strings.ToLower(strings.TrimSpace(raw))
	d = strings.TrimPrefix(strings.TrimPrefix(d, "https://"), "http://")
	d = strings.TrimPrefix(strings.TrimRight(d, "/"), "www.")
	if d == "" || !strings.Contains(d, ".") || strings.ContainsAny(d, " /") {
		return apiCompany{}, false, nil
	}
	var pg page[apiCompany]
	if err := c.get(ctx, "/v1/companies", url.Values{"q": {d}, "limit": {"50"}}, &pg); err != nil {
		return apiCompany{}, false, err
	}
	for _, co := range pg.Data {
		if strings.EqualFold(co.Domain, d) {
			return co, true, nil
		}
	}
	return apiCompany{}, false, nil
}

func updateCompany(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[companyArgs](raw)
	if err != nil {
		return nil, err
	}
	if len(a.Labels) > 0 || a.IfExists != "" {
		return nil, invalid("update_company takes add_labels and remove_labels; labels and if_exists are create_company's")
	}
	co, err := findCompany(ctx, c, a.Company)
	if err != nil {
		return nil, err
	}
	b, err := a.body()
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, invalid("nothing to change: pass at least one value to set")
	}
	var updated apiCompany
	if err := c.do(ctx, http.MethodPatch, "/v1/companies/"+co.ID, nil, b, &updated); err != nil {
		return nil, err
	}
	return companyWritten{Company: compactCompany(updated, true)}, nil
}
