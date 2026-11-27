package widget_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/helpdesk/widget"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/storage"
)

// signingStore signs download links, as the S3 store does.
type signingStore struct{ storage.Storage }

func (signingStore) SignedURL(_ context.Context, key, _ string, _ time.Duration) (string, error) {
	return "https://files.example.com/" + key, nil
}

// A store that signs links gets a redirect, unless the link asks for the bytes (stream=1, the
// app's preview), which come from the API with the same download headers.
func TestAttachmentStreamsOnRequest(t *testing.T) {
	e := hdtest.New(t, widget.Register)
	ws := e.NewWorkspace()
	pdf := []byte("%PDF-1.4\n%%EOF\n")
	var att domain.Attachment
	e.Upload("/v1/attachments", ws.Admin.As(ws), "invoice.pdf", pdf).Want(t, 201).JSON(t, &att)

	d := *e.D
	d.Storage = signingStore{e.D.Storage}
	r := chi.NewRouter()
	r.Use(httpx.RequestID, httpx.CORS([]string{"http://app.test"}))
	widget.Register(&d, humachi.New(r, huma.DefaultConfig("opendesk test", "test")), r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	signed, err := url.Parse(domain.AttachmentURL(att.ID))
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(query string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+signed.Path+"?"+query, nil)
		req.Header.Set("Origin", "http://app.test")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}

	if res := get(signed.RawQuery); res.StatusCode != http.StatusFound || res.Header.Get("Location") == "" {
		t.Fatalf("download %d %q", res.StatusCode, res.Header.Get("Location"))
	}
	res := get(signed.RawQuery + "&stream=1")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stream %d", res.StatusCode)
	}
	h := res.Header
	for k, want := range map[string]string{
		"Content-Type":                "application/pdf",
		"X-Content-Type-Options":      "nosniff",
		"Content-Security-Policy":     "default-src 'none'; sandbox",
		"Access-Control-Allow-Origin": "http://app.test",
	} {
		if h.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, h.Get(k), want)
		}
	}
	if disp := h.Get("Content-Disposition"); len(disp) < 10 || disp[:10] != "attachment" {
		t.Errorf("Content-Disposition = %q", disp)
	}
	// The bytes still need the link's signature or access.
	if res := get("stream=1"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unsigned stream %d", res.StatusCode)
	}
}
