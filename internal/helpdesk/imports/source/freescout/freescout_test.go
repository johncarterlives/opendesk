package freescout

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/useopendesk/opendesk/internal/helpdesk/imports/source"
)

const testKey = "freescout-secret-key"

func testSource(t *testing.T, handler http.HandlerFunc) (source.Source, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	s, err := New(source.Credentials{"url": srv.URL + "/support/", "api_key": testKey}, source.Options{Dev: true})
	if err != nil {
		t.Fatal(err)
	}
	return s, srv
}
func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Error(err)
	}
}
func response(key string, items any, page, total, totalPages int) map[string]any {
	return map[string]any{"_embedded": map[string]any{key: items}, "page": map[string]any{"number": page, "totalElements": total, "totalPages": totalPages}}
}
func assertAuth(t *testing.T, r *http.Request) {
	t.Helper()
	if r.Header.Get("X-FreeScout-API-Key") != testKey || r.Header.Get("Authorization") != "" || strings.Contains(r.URL.String(), testKey) || r.URL.Query().Has("api_key") {
		t.Errorf("authentication must use only the API key header")
	}
}
func assertConversationQuery(t *testing.T, r *http.Request) {
	t.Helper()
	q := r.URL.Query()
	for k, want := range map[string]string{"status": "active,pending,closed,spam", "state": "published", "sortField": "createdAt", "sortOrder": "asc", "embed": "threads,tags", "pageSize": "25"} {
		if q.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, q.Get(k), want)
		}
	}
}
func TestNew(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, url, key string
		dev, valid     bool
	}{
		{"root", "https://support.example.org", testKey, false, true},
		{"subdirectory", "https://support.example.org/help/desk/", testKey, false, true},
		{"missing scheme", "support.example.org", testKey, false, false},
		{"http", "http://support.example.org", testKey, false, false},
		{"development public http", "http://support.example.org", testKey, true, false},
		{"development localhost", "http://localhost:8000/support", testKey, true, true},
		{"userinfo", "https://user:password@support.example.org", testKey, false, false},
		{"query", "https://support.example.org?api_key=secret", testKey, false, false},
		{"empty query", "https://support.example.org?", testKey, false, false},
		{"fragment", "https://support.example.org#fragment", testKey, false, false},
		{"empty fragment", "https://support.example.org#", testKey, false, false},
		{"missing key", "https://support.example.org", "", false, false},
		{"header newline", "https://support.example.org", "key\r\nAuthorization: bad", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(source.Credentials{"url": tc.url, "api_key": tc.key}, source.Options{Dev: tc.dev})
			if (err == nil) != tc.valid {
				t.Fatalf("New error = %v; valid = %v", err, tc.valid)
			}
			if err != nil && !errors.Is(err, source.ErrInvalid) {
				t.Fatalf("expected validation error, got %v", err)
			}
		})
	}
}

func TestCheckPagination(t *testing.T) {
	t.Parallel()
	counts := map[string]int{}
	s, srv := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		counts[r.URL.Path]++
		p := r.URL.Query().Get("page")
		switch r.URL.Path {
		case "/support/api/mailboxes":
			if p == "1" {
				writeJSON(t, w, response("mailboxes", []any{map[string]any{"id": 1, "name": "Support"}}, 1, 2, 2))
			} else if p == "2" {
				writeJSON(t, w, response("mailboxes", []any{map[string]any{"id": 2, "name": "Sales"}}, 2, 2, 2))
			} else {
				t.Errorf("unexpected page %s", p)
			}
		case "/support/api/users":
			if p == "1" {
				writeJSON(t, w, response("users", []any{map[string]any{"id": 8, "firstName": "Ada", "lastName": "Agent", "email": "ada@example.org"}}, 1, 2, 2))
			} else {
				writeJSON(t, w, response("users", []any{map[string]any{"id": 9, "email": "bea@example.org"}}, 2, 2, 2))
			}
		case "/support/api/conversations":
			if q := r.URL.Query(); q.Get("pageSize") != "1" || q.Has("embed") || q.Get("state") != "published" {
				t.Errorf("count query = %v", q)
			}
			writeJSON(t, w, response("conversations", []any{}, 1, 17, 1))
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	})
	scan, err := s.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if scan.Account.Key != srv.URL+"/support" || scan.Account.URL != scan.Account.Key {
		t.Errorf("account = %+v", scan.Account)
	}
	if scan.Tickets != 17 || scan.Articles != 0 || scan.HasArticles {
		t.Errorf("counts = %+v", scan)
	}
	if len(scan.Groups) != 2 || scan.Groups[1].ID != "2" || len(scan.Agents) != 2 || scan.Agents[0].Name != "Ada Agent" || scan.Agents[1].Name != "bea@example.org" {
		t.Fatalf("mapping = %+v", scan)
	}
	if counts["/support/api/mailboxes"] != 2 || counts["/support/api/users"] != 2 {
		t.Errorf("pagination = %v", counts)
	}
	if _, err := s.Articles(context.Background(), ""); !errors.Is(err, source.ErrUnsupported) {
		t.Fatalf("Articles = %v", err)
	}
}

func conversationFixture(id int, status, state string) map[string]any {
	return map[string]any{"id": id, "number": 100 + id, "threadsCount": 0, "type": "email", "status": status, "state": state, "subject": "Refund", "mailboxId": 2, "assignee": map[string]any{"id": 8, "type": "user"}, "customer": map[string]any{"id": 91, "firstName": "Rodney", "lastName": "Customer", "email": "rodney@example.org", "company": "Acme", "phone": "123"}, "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-02-01T00:00:00Z", "closedAt": "2024-02-01T00:00:00Z", "_embedded": map[string]any{"threads": []any{}, "tags": []any{map[string]any{"name": "refund"}}}}
}
func TestTicketsPaginationAndMapping(t *testing.T) {
	t.Parallel()
	since := source.Time("2024-01-01T00:00:00Z")
	updated := source.Time("2024-02-01T00:00:00Z")
	s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		assertConversationQuery(t, r)
		q := r.URL.Query()
		if q.Get("createdSince") != since.Format(time.RFC3339) || q.Get("updatedSince") != updated.Format(time.RFC3339) {
			t.Errorf("date filters = %v", q)
		}
		switch q.Get("page") {
		case "1":
			writeJSON(t, w, response("conversations", []any{conversationFixture(1, "active", "published"), conversationFixture(2, "pending", "published")}, 1, 6, 2))
		case "2":
			writeJSON(t, w, response("conversations", []any{conversationFixture(3, "closed", "published"), conversationFixture(4, "spam", "published"), conversationFixture(5, "active", "deleted"), conversationFixture(6, "active", "draft")}, 2, 6, 2))
		default:
			t.Errorf("unexpected page")
		}
	})
	first, err := s.Tickets(context.Background(), "", &since, &updated)
	if err != nil {
		t.Fatal(err)
	}
	if first.Next != "2" || len(first.Items) != 2 {
		t.Fatalf("first page = %+v", first)
	}
	second, err := s.Tickets(context.Background(), first.Next, &since, &updated)
	if err != nil {
		t.Fatal(err)
	}
	if second.Next != "" || len(second.Items) != 4 {
		t.Fatalf("second page = %+v", second)
	}
	tickets := append(first.Items, second.Items...)
	for i, want := range []string{"open", "pending", "closed", "closed", "open", "open"} {
		if tickets[i].Status != want || tickets[i].Skip != (i >= 3) {
			t.Errorf("ticket %d: %+v", i, tickets[i])
		}
	}
	ticket := tickets[0]
	if ticket.AssigneeID != "8" || ticket.GroupID != "2" || ticket.Ref != "#101" || !ticket.Loaded || ticket.Requester == nil || ticket.Requester.Company != "Acme" || ticket.Requester.Email != "rodney@example.org" || !reflect.DeepEqual(ticket.Tags, []string{"refund"}) {
		t.Errorf("ticket mapping = %+v", ticket)
	}
	if _, err := s.Tickets(context.Background(), "https://evil.example/", nil, nil); err == nil {
		t.Fatal("URL cursor accepted")
	}
}

func threadFixture(id int, kind, state, at string) map[string]any {
	return map[string]any{"id": id, "type": kind, "state": state, "body": fmt.Sprintf("<p>Message %d</p>", id), "createdAt": at, "createdBy": map[string]any{"id": 8, "type": "user", "firstName": "Ada", "email": "ada@example.org"}, "to": []string{"rodney@example.org"}, "cc": []string{"cc@example.org"}}
}
func TestLoadEmbeddedThreadsAndAttachments(t *testing.T) {
	t.Parallel()
	calls := 0
	s, srv := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		calls++
		if r.URL.Path != "/support/api/conversations/1" || r.URL.Query().Get("embed") != "threads,tags" {
			t.Errorf("unexpected detail request: %s", r.URL)
		}
		c := conversationFixture(1, "closed", "published")
		customer := threadFixture(10, "customer", "published", "2024-01-01T01:00:00Z")
		customer["customer"] = map[string]any{"id": 91, "firstName": "Rodney", "email": "rodney@example.org"}
		customer["_embedded"] = map[string]any{"attachments": []any{map[string]any{"id": 71, "fileName": "example.pdf", "fileUrl": "/storage/example.pdf", "mimeType": "application/pdf", "size": 2331}}}
		threads := []any{threadFixture(13, "note", "published", "2024-01-03T01:00:00Z"), threadFixture(12, "message", "published", "2024-01-02T01:00:00Z"), customer, threadFixture(14, "message", "draft", "2024-01-04T01:00:00Z"), threadFixture(15, "lineitem", "published", "2024-01-05T01:00:00Z"), threadFixture(16, "note", "hidden", "2024-01-06T01:00:00Z"), threadFixture(17, "note", "review", "2024-01-07T01:00:00Z"), threadFixture(18, "message", "", "2024-01-08T01:00:00Z")}
		c["threadsCount"] = len(threads)
		c["_embedded"].(map[string]any)["threads"] = threads
		writeJSON(t, w, c)
	})
	ticket := source.Ticket{ID: "1"}
	if err := s.Load(context.Background(), &ticket); err != nil {
		t.Fatal(err)
	}
	if !ticket.Loaded || len(ticket.Messages) != 4 || ticket.Messages[3].ID != "18" {
		t.Fatalf("ticket = %+v", ticket)
	}
	customer, reply, note := ticket.Messages[0], ticket.Messages[1], ticket.Messages[2]
	if customer.ID != "10" || customer.Agent || customer.Note || customer.AuthorID != "" || customer.Author.ID != "91" || customer.Author.Email != "rodney@example.org" {
		t.Errorf("customer = %+v", customer)
	}
	if reply.ID != "12" || !reply.Agent || reply.Note || reply.AuthorID != "8" || reply.Author.Name != "Ada" || len(reply.To) != 1 || len(reply.Cc) != 1 {
		t.Errorf("reply = %+v", reply)
	}
	if note.ID != "13" || !note.Agent || !note.Note {
		t.Errorf("note = %+v", note)
	}
	if len(customer.Attachments) != 1 || customer.Attachments[0].ContentType != "application/pdf" || customer.Attachments[0].Size != 2331 || customer.Attachments[0].Name != "example.pdf" {
		t.Errorf("attachments = %+v", customer.Attachments)
	}
	if ticket.URL != srv.URL+"/support/conversation/1" || ticket.SolvedAt == nil {
		t.Errorf("ticket detail = %+v", ticket)
	}
	if err := s.Load(context.Background(), &ticket); err != nil || calls != 1 {
		t.Errorf("loaded again: %v, calls %d", err, calls)
	}
}

func TestLoadRefusesTruncatedThreads(t *testing.T) {
	t.Parallel()
	s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		c := conversationFixture(1, "active", "published")
		c["threadsCount"] = 2
		c["_embedded"].(map[string]any)["threads"] = []any{threadFixture(1, "customer", "published", "2024-01-01T00:00:00Z")}
		writeJSON(t, w, c)
	})
	ticket := source.Ticket{ID: "1"}
	if err := s.Load(context.Background(), &ticket); err == nil || ticket.Loaded {
		t.Fatal("truncated conversation accepted as complete")
	}
}

func TestListingThreadCountMarksTruncatedThreads(t *testing.T) {
	t.Parallel()
	s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		c := conversationFixture(1, "active", "published")
		delete(c, "threadsCount")
		c["threads"] = 2
		c["_embedded"].(map[string]any)["threads"] = []any{threadFixture(1, "customer", "published", "2024-01-01T00:00:00Z")}
		writeJSON(t, w, response("conversations", []any{c}, 1, 1, 1))
	})
	page, err := s.Tickets(context.Background(), "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Loaded {
		t.Fatalf("listing with fewer threads than its count marked loaded: %+v", page.Items)
	}
}

func TestParseTime(t *testing.T) {
	t.Parallel()
	want := time.Date(2024, 3, 5, 14, 7, 9, 0, time.UTC)
	for _, in := range []string{"2024-03-05T14:07:09Z", "2024-03-05T16:07:09+02:00", "2024-03-05T14-07-09Z", " 2024-03-05T14-07-09Z "} {
		if got := parseTime(in); !got.Equal(want) || got.Location() != time.UTC {
			t.Errorf("parseTime(%q) = %v", in, got)
		}
	}
	for _, in := range []string{"", "yesterday", "2024-03-05"} {
		if got := parseTime(in); !got.IsZero() {
			t.Errorf("parseTime(%q) = %v, want zero", in, got)
		}
	}
}

func TestErrorsNeverEchoCredentials(t *testing.T) {
	t.Parallel()
	for _, status := range []int{401, 403, 404, 429, 422, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(status)
				fmt.Fprint(w, "rejected API key "+testKey)
			})
			_, err := s.Check(context.Background())
			if err == nil || strings.Contains(err.Error(), testKey) {
				t.Fatalf("unsafe/missing error: %v", err)
			}
			if status == 401 || status == 403 {
				if !errors.Is(err, source.ErrAuth) {
					t.Errorf("auth = %v", err)
				}
			}
			if status == 429 {
				var limited *source.RateLimited
				if !errors.As(err, &limited) || limited.RetryAfter != 7*time.Second {
					t.Errorf("rate limit = %v", err)
				}
			}
		})
	}
}

func TestDownloadsGuardCredentialsAndRedirects(t *testing.T) {
	t.Parallel()
	otherRequests := 0
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherRequests++
		if r.Header.Get("X-FreeScout-API-Key") != "" {
			t.Error("API key leaked to file host")
		}
		fmt.Fprint(w, "other file")
	}))
	t.Cleanup(other.Close)
	s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		switch r.URL.Path {
		case "/support/file":
			fmt.Fprint(w, "own file")
		case "/support/redirect":
			http.Redirect(w, r, other.URL+"/file", http.StatusFound)
		default:
			t.Errorf("unexpected file %s", r.URL.Path)
		}
	})
	for _, tc := range []struct{ name, url, want string }{{"same origin", "file", "own file"}, {"external", other.URL + "/file", "other file"}, {"redirect", "redirect", "other file"}} {
		t.Run(tc.name, func(t *testing.T) {
			rd, err := s.Download(context.Background(), source.Attachment{URL: tc.url})
			if err != nil {
				t.Fatal(err)
			}
			defer rd.Close()
			body, err := io.ReadAll(rd)
			if err != nil || string(body) != tc.want {
				t.Fatalf("download = %q, %v", body, err)
			}
		})
	}
	if otherRequests != 2 {
		t.Errorf("external requests = %d", otherRequests)
	}
}

func TestAPIRedirectDoesNotForwardKey(t *testing.T) {
	t.Parallel()
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; t.Error("API redirect was followed") }))
	t.Cleanup(target.Close)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	t.Cleanup(srv.Close)
	// Even an injected client that follows redirects must not send the custom header.
	s, err := New(source.Credentials{"url": srv.URL, "api_key": testKey}, source.Options{Dev: true, HTTP: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Check(context.Background()); err == nil || leaked {
		t.Fatalf("redirect accepted: %v", err)
	}
}

func TestBlockedDestinations(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"https://127.0.0.1", "https://169.254.169.254/latest/meta-data", "https://10.0.0.1"} {
		t.Run(raw, func(t *testing.T) {
			s, err := New(source.Credentials{"url": raw, "api_key": testKey}, source.Options{})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Check(context.Background()); err == nil {
				t.Fatal("private API accepted")
			}
			if _, err := s.Download(context.Background(), source.Attachment{URL: raw + "/file"}); err == nil {
				t.Fatal("private attachment accepted")
			}
		})
	}
}
func TestHTTPSDownloadRefusesDowngrade(t *testing.T) {
	t.Parallel()
	hits := 0
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		assertAuth(t, r)
		http.Redirect(w, r, "http://"+r.Host+"/file", http.StatusFound)
	}))
	t.Cleanup(tls.Close)
	s, err := New(source.Credentials{"url": tls.URL, "api_key": testKey}, source.Options{Dev: true, HTTP: tls.Client(), Files: tls.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Download(context.Background(), source.Attachment{URL: tls.URL + "/file"}); err == nil {
		t.Fatal("HTTPS downgrade accepted")
	}
	if hits != 1 {
		t.Errorf("requests = %d", hits)
	}
}

func TestDownloadTimeoutRedactsSignedURL(t *testing.T) {
	raw := &source.Unreachable{Err: &url.Error{Op: "Get", URL: "https://files.example.test/file?token=" + testKey, Err: context.DeadlineExceeded}}
	err := safeError(raw)
	var unreachable *source.Unreachable
	if !errors.As(err, &unreachable) || strings.Contains(err.Error(), testKey) || strings.Contains(err.Error(), "token=") {
		t.Fatalf("unsafe timeout error: %v", err)
	}
	cancelled := safeError(&url.Error{Op: "Get", URL: "https://files.example.test/?token=" + testKey, Err: context.Canceled})
	if cancelled != context.Canceled {
		t.Fatalf("unsafe cancellation error: %v", cancelled)
	}
}
