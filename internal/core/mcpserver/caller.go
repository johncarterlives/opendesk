package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/idempotency"
)

// caller runs a tool's requests through the public API in process, as the API key:
// every tool gets exactly the key's scopes, validation, events, activities and audit
// entries the same request over HTTP would.
type caller struct {
	h http.Handler
	// srv is the MCP handler, for the API bridge's catalog.
	srv *Handler
	// files downloads a file a tool names by URL.
	files *fileFetcher
	p     *auth.Principal
	// idem derives the Idempotency-Key of a write from its route and body.
	idem func(method, path string, body []byte) string
	// names caches team and brand names for the tool call.
	names *refNames
}

// apiError is a non-2xx answer from the API, kept as its problem body.
type apiError struct {
	Status int
	Code   string
	Detail string
}

func (e *apiError) Error() string { return e.Detail }

// errInput is a tool argument the server refuses before calling the API.
type errInput struct{ msg string }

func (e *errInput) Error() string { return e.msg }

func invalid(msg string) error { return &errInput{msg} }

// statusOf is the HTTP status of an API error, or 0.
func statusOf(err error) int {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

// do sends one JSON request and decodes a 2xx JSON answer into out (when non-nil).
func (c *caller) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return err
		}
	}
	contentType := ""
	if raw != nil {
		contentType = "application/json"
	}
	resp, err := c.send(ctx, method, path, query, contentType, raw)
	if err != nil {
		return err
	}
	if out != nil && len(resp) > 0 {
		return json.Unmarshal(resp, out)
	}
	return nil
}

// send sends one request with a body of contentType and returns a 2xx answer's body.
// Anything else is an *apiError with the problem's detail.
func (c *caller) send(ctx context.Context, method, path string, query url.Values, contentType string, raw []byte) ([]byte, error) {
	target := path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var rd io.Reader
	if raw != nil {
		rd = bytes.NewReader(raw)
	}
	// The MCP request's context may carry the outer request's chi routing state, which
	// the router would reuse instead of routing this request afresh.
	ctx = context.WithValue(ctx, chi.RouteCtxKey, (*chi.Context)(nil))
	req := httptest.NewRequestWithContext(auth.WithPrincipal(ctx, c.p), method, target, rd)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if method == http.MethodPost && c.idem != nil {
		if k := c.idem(method, path, raw); k != "" {
			req.Header.Set(idempotency.Header, k)
		}
	}
	req.RemoteAddr = "127.0.0.1:0"
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	if rec.Code < 200 || rec.Code > 299 {
		var p struct {
			Code   string `json:"code"`
			Detail string `json:"detail"`
			Title  string `json:"title"`
			Errors []struct {
				Message  string `json:"message"`
				Location string `json:"location"`
			} `json:"errors"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &p)
		detail := p.Detail
		if len(p.Errors) > 0 && p.Errors[0].Message != "" {
			detail = strings.TrimSpace(detail + " (" + strings.TrimPrefix(p.Errors[0].Location, "body.") + ": " + p.Errors[0].Message + ")")
		}
		if detail == "" {
			detail = p.Title
		}
		if detail == "" {
			detail = http.StatusText(rec.Code)
		}
		return nil, &apiError{Status: rec.Code, Code: p.Code, Detail: detail}
	}
	return rec.Body.Bytes(), nil
}

func (c *caller) get(ctx context.Context, path string, q url.Values, out any) error {
	return c.do(ctx, http.MethodGet, path, q, nil, out)
}

var ticketNumber = regexp.MustCompile(`^#?([1-9][0-9]{0,11})$`)

// ticketRef validates a ticket reference ("#123", "123" or a uuid) and returns it as a
// safe path segment.
func ticketRef(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if id, err := uuid.Parse(raw); err == nil {
		return id.String(), nil
	}
	if m := ticketNumber.FindStringSubmatch(raw); m != nil {
		return url.PathEscape("#" + m[1]), nil
	}
	return "", invalid("ticket must be a ticket number like #123 or a ticket id")
}

// idRef validates a uuid argument and returns it as a safe path segment.
func idRef(raw, what string) (string, error) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", invalid(what + " must be an id")
	}
	return id.String(), nil
}
