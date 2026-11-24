package mcpserver

import (
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
)

// The API catalog indexes the public API's OpenAPI document so an AI client can find,
// read and call any documented route (find_api, describe_api, api_read, api_write). It
// decides which routes a client may call and whether a call reads or writes; the route
// itself still authorizes every call as the caller, with its scopes and role.

type apiKind string

const (
	kindRead  apiKind = "read"
	kindWrite apiKind = "write"
)

// apiOperation is one documented method and path.
type apiOperation struct {
	ID          string  `json:"operation_id,omitempty"`
	Method      string  `json:"method"`
	Path        string  `json:"path"`
	Tag         string  `json:"area,omitempty"`
	Summary     string  `json:"summary,omitempty"`
	Kind        apiKind `json:"kind"`
	Unavailable string  `json:"unavailable,omitempty" doc:"Why a client cannot call it; empty when it can"`

	description string
	segments    []string
	raw         map[string]any
}

func (o *apiOperation) key() string { return o.Method + " " + o.Path }

type apiCatalog struct {
	ops        []*apiOperation
	schemas    map[string]any
	parameters map[string]any
}

// blockedAreas are parts of the API an AI client never calls through the bridge: the
// member's own account and sign-in, credentials that would land in a conversation, the
// instance admin, and surfaces that are not a workspace's (visitors, customers, inbound).
var blockedAreas = []struct{ prefix, reason string }{
	{"/v1/auth", "sign-in and sessions belong to the member, in the app"},
	{"/v1/me", "the member's own account, password, two-factor and sessions are changed in the app"},
	{"/v1/oauth", "AI client connections are approved and revoked in the app"},
	{"/v1/ai-clients", "AI client connections are managed in Settings → AI clients"},
	{"/v1/api-keys", "an API key's secret must not pass through a conversation; create keys in Settings → API keys"},
	{"/v1/webhooks", "a webhook's signing secret must not pass through a conversation; manage webhooks in Settings → Webhooks"},
	{"/v1/admin", "the instance admin panel is for the instance's operators"},
	{"/v1/billing", "plans and payment are changed in Settings → Billing"},
	{"/v1/realtime", "realtime tokens are for the app's own connection"},
	{"/v1/events", "event replay is the app's realtime catch-up; read the current state with the other routes"},
	{"/v1/push", "push devices belong to the member's own apps"},
	{"/v1/public", "public routes serve the help center, not the workspace"},
	{"/v1/widget", "widget routes serve chat visitors, not the workspace"},
	{"/v1/customer", "customer portal routes serve customers, not the workspace"},
	{"/v1/inbound", "inbound mail is delivered by the mail worker"},
	{"/v1/workspaces", "workspaces are created, switched and deleted by their members in the app"},
	{"/v1/invitations", "invitations are accepted by the person invited"},
}

const credentialReason = "takes a credential, which must not pass through a conversation; enter it in the app, where it is encrypted"

// parseCatalog indexes an OpenAPI 3 document.
func parseCatalog(spec []byte) (*apiCatalog, error) {
	var doc struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas    map[string]any `json:"schemas"`
			Parameters map[string]any `json:"parameters"`
		} `json:"components"`
	}
	if err := json.Unmarshal(spec, &doc); err != nil {
		return nil, err
	}
	c := &apiCatalog{schemas: doc.Components.Schemas, parameters: doc.Components.Parameters}
	for p, item := range doc.Paths {
		for _, m := range []string{"get", "post", "put", "patch", "delete"} {
			rawOp, ok := item[m]
			if !ok {
				continue
			}
			var op map[string]any
			if err := json.Unmarshal(rawOp, &op); err != nil {
				return nil, err
			}
			o := &apiOperation{Method: strings.ToUpper(m), Path: p, ID: strOf(op["operationId"]), Summary: strOf(op["summary"]),
				description: strOf(op["description"]), raw: op, segments: splitPath(p)}
			if tags, _ := op["tags"].([]any); len(tags) > 0 {
				o.Tag = strOf(tags[0])
			}
			o.Kind, o.Unavailable = c.classify(o)
			c.ops = append(c.ops, o)
		}
	}
	sort.Slice(c.ops, func(i, j int) bool {
		if c.ops[i].Path != c.ops[j].Path {
			return c.ops[i].Path < c.ops[j].Path
		}
		return c.ops[i].Method < c.ops[j].Method
	})
	return c, nil
}

// classify decides whether an operation reads or writes, and whether a client may call it.
func (c *apiCatalog) classify(o *apiOperation) (apiKind, string) {
	kind := kindWrite
	if o.Method == "GET" {
		kind = kindRead
	}
	for _, a := range blockedAreas {
		if o.Path == a.prefix || strings.HasPrefix(o.Path, a.prefix+"/") {
			return kind, a.reason
		}
	}
	for _, seg := range o.segments {
		if strings.Contains(seg, "rotate") {
			return kind, "rotating a secret returns the new one, which must not pass through a conversation; rotate it in the app"
		}
	}
	if sec, ok := o.raw["security"].([]any); ok && len(sec) == 0 {
		return kind, "a public route with no workspace"
	}
	if body, ok := o.raw["requestBody"].(map[string]any); ok {
		content, _ := body["content"].(map[string]any)
		if _, isJSON := content["application/json"]; !isJSON && len(content) > 0 {
			if o.key() == "POST /v1/attachments" {
				return kind, "a file upload; use upload_attachment"
			}
			return kind, "takes a file upload, which this bridge cannot send; upload it in the app"
		}
		if c.takesSecret(jsonSchema(body), 5, nil) {
			return kind, credentialReason
		}
	}
	return kind, ""
}

// takesSecret reports whether a request schema has a credential-shaped property within depth.
func (c *apiCatalog) takesSecret(v any, depth int, stack []string) bool {
	switch x := v.(type) {
	case map[string]any:
		if name, ok := strings.CutPrefix(strOf(x["$ref"]), "#/components/schemas/"); ok {
			for _, s := range stack {
				if s == name {
					return false
				}
			}
			return depth > 0 && c.takesSecret(c.schemas[name], depth-1, append(stack, name))
		}
		if props, ok := x["properties"].(map[string]any); ok {
			for k := range props {
				if secretField(k) {
					return true
				}
			}
		}
		for _, e := range x {
			if c.takesSecret(e, depth, stack) {
				return true
			}
		}
	case []any:
		for _, e := range x {
			if c.takesSecret(e, depth, stack) {
				return true
			}
		}
	}
	return false
}

// secretField reports whether a JSON member name holds a credential.
func secretField(name string) bool {
	k := strings.ToLower(name)
	switch k {
	case "secret", "password", "token", "api_key", "apikey", "credentials", "private_key", "header_value", "refresh_token", "access_token",
		"webhook_url":
		return true
	}
	for _, suf := range []string{"_secret", "_password", "_token", "_api_key", "_private_key", "_credentials", "_signing_key", "_webhook_url"} {
		if strings.HasSuffix(k, suf) {
			return true
		}
	}
	return false
}

// areas lists the API's areas with their operation counts.
func (c *apiCatalog) areas() map[string]int {
	out := map[string]int{}
	for _, o := range c.ops {
		out[o.Tag]++
	}
	return out
}

type apiSearchResult struct {
	Operations []*apiOperation `json:"operations"`
	Total      int             `json:"total"`
	NextOffset *int            `json:"next_offset,omitempty"`
}

// search ranks operations by how many query terms their path, summary, id, description
// and area contain. An empty query lists everything in area.
func (c *apiCatalog) search(query, area string, offset, limit int) apiSearchResult {
	terms := strings.Fields(strings.ToLower(query))
	type hit struct {
		op    *apiOperation
		score int
	}
	var hits []hit
	for _, o := range c.ops {
		if area != "" && !strings.EqualFold(o.Tag, area) {
			continue
		}
		head := strings.ToLower(o.Method + " " + o.Path + " " + o.Summary + " " + o.ID)
		body := strings.ToLower(o.description + " " + o.Tag)
		score := 0
		for _, t := range terms {
			if strings.Contains(head, t) {
				score += 3
			} else if strings.Contains(body, t) {
				score++
			}
		}
		if len(terms) == 0 || score > 0 {
			hits = append(hits, hit{o, score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	offset = max(0, min(offset, len(hits)))
	end := min(offset+limit, len(hits))
	res := apiSearchResult{Total: len(hits), Operations: make([]*apiOperation, 0, end-offset)}
	for _, h := range hits[offset:end] {
		res.Operations = append(res.Operations, h.op)
	}
	if end < len(hits) {
		res.NextOffset = &end
	}
	return res
}

var (
	errNoOperation = errors.New("no documented route has that method and path; look it up with find_api")
	errBadPath     = errors.New("path must be an API path such as /v1/tickets/123, with no query string, host or dot segments")
)

// match finds the operation a concrete path belongs to, and returns the path with each
// segment escaped. A literal segment beats a parameter, so /v1/tickets/bulk wins over
// /v1/tickets/{id}.
func (c *apiCatalog) match(method, p string) (*apiOperation, string, error) {
	segs, err := cleanPath(p)
	if err != nil {
		return nil, "", err
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	var best *apiOperation
	bestLiterals := -1
	for _, o := range c.ops {
		if o.Method != method || len(o.segments) != len(segs) {
			continue
		}
		literals, ok := 0, true
		for i, s := range o.segments {
			if isParam(s) {
				continue
			}
			if s != segs[i] {
				ok = false
				break
			}
			literals++
		}
		if ok && literals > bestLiterals {
			best, bestLiterals = o, literals
		}
	}
	if best == nil {
		return nil, "", errNoOperation
	}
	escaped := make([]string, len(segs))
	for i, s := range segs {
		escaped[i] = url.PathEscape(s)
	}
	return best, "/" + strings.Join(escaped, "/"), nil
}

// find returns the operation documented at exactly this method and path template.
func (c *apiCatalog) find(method, template string) *apiOperation {
	method = strings.ToUpper(strings.TrimSpace(method))
	template = withVersion(strings.TrimSpace(template))
	for _, o := range c.ops {
		if o.Method == method && o.Path == template {
			return o
		}
	}
	return nil
}

func withVersion(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if p != "/v1" && !strings.HasPrefix(p, "/v1/") {
		p = "/v1" + p
	}
	return p
}

// cleanPath splits a concrete path into unescaped segments, refusing anything that is
// not a plain path: a query, fragment, scheme, empty or dot segment, or control character.
func cleanPath(p string) ([]string, error) {
	p = strings.TrimSpace(p)
	if p == "" || strings.ContainsAny(p, "?\\ \t\r\n") || strings.Contains(p, "//") || strings.Contains(p, "://") {
		return nil, errBadPath
	}
	segs := splitPath(withVersion(p))
	for i, s := range segs {
		u, err := url.PathUnescape(s)
		if err != nil || u == "" || u == "." || u == ".." || strings.ContainsAny(u, "/\\") {
			return nil, errBadPath
		}
		for _, r := range u {
			if r < 0x20 || r == 0x7f {
				return nil, errBadPath
			}
		}
		segs[i] = u
	}
	return segs, nil
}

func splitPath(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

func isParam(seg string) bool { return strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") }

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

// --- describe --------------------------------------------------------------------------

// describeBudget bounds a description so one large schema cannot flood the client's context.
const describeBudget = 14000

type apiParam struct {
	Name        string `json:"name"`
	In          string `json:"in"`
	Required    bool   `json:"required,omitempty"`
	Description string `json:"description,omitempty"`
	Schema      any    `json:"schema,omitempty"`
}

type apiDescription struct {
	apiOperation
	Description string     `json:"description,omitempty"`
	Params      []apiParam `json:"params,omitempty"`
	Body        any        `json:"body,omitempty"`
	Response    any        `json:"response,omitempty"`
	// Truncated means deep schemas were cut to fit; nested objects show only their schema name.
	Truncated bool `json:"truncated,omitempty"`
}

// describe resolves an operation's parameters, request body and success response,
// inlining schema references as deep as the budget allows.
func (c *apiCatalog) describe(o *apiOperation) apiDescription {
	var d apiDescription
	for depth := 6; depth >= 1; depth-- {
		d = c.describeAt(o, depth)
		d.Truncated = depth < 6
		if b, _ := json.Marshal(d); len(b) <= describeBudget {
			return d
		}
	}
	d.Response = nil
	d.Truncated = true
	return d
}

func (c *apiCatalog) describeAt(o *apiOperation, depth int) apiDescription {
	d := apiDescription{apiOperation: *o, Description: o.description}
	params, _ := o.raw["parameters"].([]any)
	for _, p := range params {
		pm, _ := c.resolveParam(p).(map[string]any)
		if pm == nil || strOf(pm["in"]) == "header" || strOf(pm["in"]) == "cookie" {
			continue
		}
		req, _ := pm["required"].(bool)
		d.Params = append(d.Params, apiParam{Name: strOf(pm["name"]), In: strOf(pm["in"]), Required: req,
			Description: strOf(pm["description"]), Schema: c.inline(pm["schema"], depth, nil)})
	}
	if body, ok := o.raw["requestBody"].(map[string]any); ok {
		if s := jsonSchema(body); s != nil {
			d.Body = c.inline(s, depth, nil)
		}
	}
	if responses, ok := o.raw["responses"].(map[string]any); ok {
		for _, code := range []string{"200", "201", "202", "204"} {
			r, _ := responses[code].(map[string]any)
			if r == nil {
				continue
			}
			if s := jsonSchema(r); s != nil {
				d.Response = c.inline(s, max(1, depth-2), nil)
			} else if desc := strOf(r["description"]); desc != "" {
				d.Response = desc
			}
			break
		}
	}
	return d
}

func jsonSchema(holder map[string]any) any {
	content, _ := holder["content"].(map[string]any)
	for _, mt := range []string{"application/json", "application/problem+json"} {
		if media, _ := content[mt].(map[string]any); media != nil {
			return media["schema"]
		}
	}
	return nil
}

func (c *apiCatalog) resolveParam(p any) any {
	m, _ := p.(map[string]any)
	if name, ok := strings.CutPrefix(strOf(m["$ref"]), "#/components/parameters/"); ok {
		return c.parameters[name]
	}
	return p
}

// inline copies a schema with its references expanded to depth, without examples.
func (c *apiCatalog) inline(v any, depth int, stack []string) any {
	switch x := v.(type) {
	case map[string]any:
		if name, ok := strings.CutPrefix(strOf(x["$ref"]), "#/components/schemas/"); ok {
			for _, s := range stack {
				if s == name {
					return map[string]any{"schema": name, "note": "recursive"}
				}
			}
			if depth <= 0 {
				return map[string]any{"schema": name}
			}
			return c.inline(c.schemas[name], depth-1, append(stack, name))
		}
		out := make(map[string]any, len(x))
		for k, e := range x {
			if k == "example" || k == "examples" || k == "$schema" || strings.HasPrefix(k, "x-") {
				continue
			}
			out[k] = c.inline(e, depth, stack)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = c.inline(e, depth, stack)
		}
		return out
	}
	return v
}
