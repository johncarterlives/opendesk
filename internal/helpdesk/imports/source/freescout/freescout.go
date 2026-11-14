// Package freescout reads FreeScout's API & Webhooks module.
// API reference: https://api-docs.freescout.net/.
package freescout

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/useopendesk/opendesk/internal/helpdesk/imports/source"
	"github.com/useopendesk/opendesk/internal/netsafe"
)

type freescout struct {
	api     *source.Client
	account source.Account
}

// New validates an instance address and API key without contacting the instance.
func New(c source.Credentials, o source.Options) (source.Source, error) {
	raw, err := source.Required(c, "url", "FreeScout URL")
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || (u.Scheme != "https" && !(u.Scheme == "http" && o.Dev && netsafe.IsLoopbackHost(u.Hostname()))) {
		return nil, source.Invalid("url", "Enter your FreeScout installation's HTTPS URL without a username, query or fragment.")
	}
	u.Host = strings.ToLower(u.Host)
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	key, err := source.Required(c, "api_key", "API key")
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(key, "\r\n") {
		return nil, source.Invalid("api_key", "Enter a valid API key.")
	}
	api := source.NewClient(u.String(), o)
	origin, _ := url.Parse(api.Base)
	api.Auth = func(r *http.Request) {
		if r.URL.Scheme == origin.Scheme && strings.EqualFold(r.URL.Host, origin.Host) {
			r.Header.Set("X-FreeScout-API-Key", key)
		}
	}
	api.HTTP = guardClient(api.HTTP, api.Dev, origin.Scheme)
	api.Files = guardClient(api.Files, api.Dev, origin.Scheme)
	return &freescout{api: api, account: source.Account{Key: u.String(), Name: u.Hostname(), URL: u.String()}}, nil
}

type guardedTransport struct {
	next   http.RoundTripper
	dev    bool
	scheme string
}

func (t guardedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if t.scheme == "https" && r.URL.Scheme != "https" {
		return nil, errors.New("refusing an HTTPS downgrade")
	}
	if _, err := (netsafe.Guard{Dev: t.dev}).ValidateURL(r.Context(), r.URL.String()); err != nil {
		return nil, err
	}
	return t.next.RoundTrip(r)
}
func guardClient(c *http.Client, dev bool, scheme string) *http.Client {
	cp := *c
	next := cp.Transport
	if next == nil {
		next = http.DefaultTransport
	}
	cp.Transport = guardedTransport{next: next, dev: dev, scheme: scheme}
	cp.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &cp
}

// API errors have fixed text: provider responses can echo submitted credentials.
func safeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var transportFailure *source.Unreachable
	if errors.As(err, &transportFailure) {
		return &source.Unreachable{Err: errors.New("could not reach FreeScout")}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	if errors.Is(err, source.ErrAuth) || errors.Is(err, source.ErrNotFound) {
		return err
	}
	var limited *source.RateLimited
	if errors.As(err, &limited) {
		return limited
	}
	var remote *source.RemoteError
	if errors.As(err, &remote) {
		return &source.RemoteError{Status: remote.Status, Detail: "FreeScout could not complete the request. Check that the API & Webhooks module is enabled."}
	}
	return errors.New("could not read the FreeScout response")
}
func (s *freescout) get(ctx context.Context, path string, q url.Values, out any) error {
	return safeError(s.api.Get(ctx, path, q, out))
}

type page struct {
	Number        int `json:"number"`
	TotalPages    int `json:"totalPages"`
	TotalElements int `json:"totalElements"`
}
type listing[T any] struct {
	Embedded map[string][]T `json:"_embedded"`
	Page     page           `json:"page"`
}

func all[T any](ctx context.Context, s *freescout, path, key string) ([]T, error) {
	var items []T
	for n := 1; n <= 10000; n++ {
		var out listing[T]
		if err := s.get(ctx, path, url.Values{"page": {strconv.Itoa(n)}, "pageSize": {"100"}}, &out); err != nil {
			return nil, err
		}
		chunk := out.Embedded[key]
		items = append(items, chunk...)
		if n >= out.Page.TotalPages {
			return items, nil
		}
		if len(chunk) == 0 {
			return nil, errors.New("freescout returned an incomplete listing")
		}
	}
	return nil, errors.New("freescout listing has too many pages")
}

type person struct {
	ID      int64  `json:"id"`
	Type    string `json:"type"`
	First   string `json:"firstName"`
	Last    string `json:"lastName"`
	Email   string `json:"email"`
	Phone   string `json:"phone"`
	Company string `json:"company"`
}

func (p person) name() string { return strings.TrimSpace(p.First + " " + p.Last) }
func (p person) person() source.Person {
	return source.Person{ID: id(p.ID), Name: p.name(), Email: strings.TrimSpace(p.Email), Phone: p.Phone, Company: p.Company}
}
func id(n int64) string {
	if n <= 0 {
		return ""
	}
	return strconv.FormatInt(n, 10)
}

type mailbox struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

func (s *freescout) Check(ctx context.Context) (source.Scan, error) {
	scan := source.Scan{Account: s.account, Tickets: -1, Articles: 0}
	boxes, err := all[mailbox](ctx, s, "/api/mailboxes", "mailboxes")
	if err != nil {
		return scan, err
	}
	for _, b := range boxes {
		scan.Groups = append(scan.Groups, source.Group{ID: id(b.ID), Name: strings.TrimSpace(b.Name)})
	}
	users, err := all[person](ctx, s, "/api/users", "users")
	if err != nil {
		return scan, err
	}
	for _, p := range users {
		name := p.name()
		if name == "" {
			name = p.Email
		}
		scan.Agents = append(scan.Agents, source.Agent{ID: id(p.ID), Name: name, Email: strings.TrimSpace(p.Email)})
	}
	q := conversationQuery(1, nil, nil)
	q.Set("pageSize", "1")
	q.Del("embed")
	var out listing[conversation]
	if err := s.get(ctx, "/api/conversations", q, &out); err != nil {
		return scan, err
	}
	scan.Tickets = out.Page.TotalElements
	return scan, nil
}

type conversation struct {
	ID          int64   `json:"id"`
	Number      int64   `json:"number"`
	Threads     int     `json:"threadsCount"`
	ListThreads int     `json:"threads"` // a listing's name for the thread count
	Type        string  `json:"type"`
	Status      string  `json:"status"`
	State       string  `json:"state"`
	Subject     string  `json:"subject"`
	MailboxID   int64   `json:"mailboxId"`
	Assignee    *person `json:"assignee"`
	Customer    *person `json:"customer"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	ClosedAt    string  `json:"closedAt"`
	Embedded    struct {
		Threads []thread `json:"threads"`
		Tags    []struct {
			Name string `json:"name"`
		} `json:"tags"`
	} `json:"_embedded"`
}
type thread struct {
	ID        int64    `json:"id"`
	Type      string   `json:"type"`
	State     string   `json:"state"`
	Body      string   `json:"body"`
	CreatedAt string   `json:"createdAt"`
	CreatedBy person   `json:"createdBy"`
	Customer  *person  `json:"customer"`
	To        []string `json:"to"`
	Cc        []string `json:"cc"`
	Embedded  struct {
		Attachments []struct {
			ID   int64  `json:"id"`
			Name string `json:"fileName"`
			URL  string `json:"fileUrl"`
			MIME string `json:"mimeType"`
			Size int64  `json:"size"`
		} `json:"attachments"`
	} `json:"_embedded"`
}

func (c conversation) threadCount() int { return max(c.Threads, c.ListThreads) }

// conversationQuery lists 25 conversations a page: each carries its threads, and one
// answer must stay within the client's size limit.
func conversationQuery(n int, since, updated *time.Time) url.Values {
	q := url.Values{"status": {"active,pending,closed,spam"}, "state": {"published"}, "embed": {"threads,tags"}, "sortField": {"createdAt"}, "sortOrder": {"asc"}, "page": {strconv.Itoa(n)}, "pageSize": {"25"}}
	if since != nil {
		q.Set("createdSince", since.UTC().Format(time.RFC3339))
	}
	if updated != nil {
		q.Set("updatedSince", updated.UTC().Format(time.RFC3339))
	}
	return q
}
func (s *freescout) Tickets(ctx context.Context, cursor string, since, updated *time.Time) (source.Page[source.Ticket], error) {
	var result source.Page[source.Ticket]
	n := 1
	if cursor != "" {
		var err error
		n, err = strconv.Atoi(cursor)
		if err != nil || n < 1 || n > 10000000 {
			return result, errors.New("freescout: invalid page cursor")
		}
	}
	var out listing[conversation]
	if err := s.get(ctx, "/api/conversations", conversationQuery(n, since, updated), &out); err != nil {
		return result, err
	}
	for _, c := range out.Embedded["conversations"] {
		result.Items = append(result.Items, s.ticket(c))
	}
	if n < out.Page.TotalPages {
		if len(result.Items) == 0 {
			return result, errors.New("freescout returned an incomplete listing")
		}
		result.Next = strconv.Itoa(n + 1)
	}
	return result, nil
}
func (s *freescout) ticket(c conversation) source.Ticket {
	t := source.Ticket{ID: id(c.ID), Ref: "#" + strconv.FormatInt(c.Number, 10), URL: s.account.URL + "/conversation/" + id(c.ID), Subject: strings.TrimSpace(c.Subject), Priority: "normal", Channel: "email", GroupID: id(c.MailboxID), CreatedAt: parseTime(c.CreatedAt), UpdatedAt: parseTime(c.UpdatedAt)}
	switch c.Status {
	case "active":
		t.Status = "open"
	case "pending":
		t.Status = "pending"
	case "closed":
		t.Status = "closed"
	default:
		t.Status = "closed"
		t.Skip = true
	}
	if c.State == "draft" || c.State == "deleted" {
		t.Skip = true
	}
	if c.Type == "chat" {
		t.Channel = "chat"
	} else if c.Type == "phone" {
		t.Channel = "api"
	}
	if c.Assignee != nil && (c.Assignee.Type == "user" || c.Assignee.Type == "") {
		t.AssigneeID = id(c.Assignee.ID)
	}
	if c.Customer != nil {
		p := c.Customer.person()
		t.Requester = &p
	}
	if at := parseTime(c.ClosedAt); !at.IsZero() {
		t.SolvedAt = &at
	}
	if t.UpdatedAt.IsZero() {
		t.UpdatedAt = t.CreatedAt
	}
	for _, tag := range c.Embedded.Tags {
		t.Tags = append(t.Tags, tag.Name)
	}
	t.Tags = source.Strings(t.Tags)
	t.Messages = messages(c.Embedded.Threads)
	t.Loaded = c.Embedded.Threads != nil && len(c.Embedded.Threads) >= c.threadCount()
	return t
}
func messages(threads []thread) []source.Message {
	ts := append([]thread(nil), threads...)
	sort.SliceStable(ts, func(i, j int) bool {
		a, b := parseTime(ts[i].CreatedAt), parseTime(ts[j].CreatedAt)
		if a.Equal(b) {
			return ts[i].ID < ts[j].ID
		}
		return a.Before(b)
	})
	var out []source.Message
	for _, th := range ts {
		switch th.State {
		case "draft", "hidden", "review":
			continue
		}
		if th.Type != "customer" && th.Type != "message" && th.Type != "note" {
			continue
		}
		p := th.CreatedBy
		if th.Type == "customer" && th.Customer != nil {
			p = *th.Customer
		}
		m := source.Message{ID: id(th.ID), Agent: th.Type != "customer", Note: th.Type == "note", Author: p.person(), HTML: th.Body, To: source.Strings(th.To), Cc: source.Strings(th.Cc), CreatedAt: parseTime(th.CreatedAt)}
		if m.Agent {
			m.AuthorID = id(p.ID)
		}
		for _, a := range th.Embedded.Attachments {
			m.Attachments = append(m.Attachments, source.Attachment{ID: id(a.ID), Name: a.Name, ContentType: a.MIME, Size: a.Size, URL: a.URL})
		}
		out = append(out, m)
	}
	return out
}
func (s *freescout) Load(ctx context.Context, t *source.Ticket) error {
	if t.Loaded {
		return nil
	}
	n, err := strconv.ParseInt(t.ID, 10, 64)
	if err != nil || n <= 0 {
		return errors.New("freescout: invalid conversation id")
	}
	var c conversation
	// FreeScout returns every thread embedded in the conversation; it does not expose
	// a paginated GET threads endpoint (the threads endpoint only creates replies).
	if err := s.get(ctx, "/api/conversations/"+id(n), url.Values{"embed": {"threads,tags"}}, &c); err != nil {
		return err
	}
	if c.ID != n || c.Embedded.Threads == nil || len(c.Embedded.Threads) < c.threadCount() {
		return errors.New("freescout returned an incomplete conversation")
	}
	*t = s.ticket(c)
	return nil
}
func (s *freescout) Articles(context.Context, string) (source.Page[source.Article], error) {
	return source.Page[source.Article]{}, source.ErrUnsupported
}
func (s *freescout) Download(ctx context.Context, a source.Attachment) (io.ReadCloser, error) {
	base, _ := url.Parse(s.api.Base + "/")
	u, err := base.Parse(a.URL)
	if err != nil {
		return nil, errors.New("invalid FreeScout attachment link")
	}
	rd, err := s.api.Open(ctx, u.String())
	return rd, safeError(err)
}

// parseTime reads RFC 3339, then the 2006-01-02T15-04-05Z form FreeScout's docs show.
func parseTime(s string) time.Time {
	if t := source.Time(s); !t.IsZero() {
		return t
	}
	t, err := time.Parse("2006-01-02T15-04-05Z", strings.TrimSpace(s))
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}
