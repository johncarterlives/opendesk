package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/useopendesk/opendesk/internal/auth"
)

// The API bridge: four tools that reach every documented API route the connection may
// call, for what no dedicated tool covers (contracts/agent.md "API bridge"). Calls go
// through the public API in process as the caller, like every other tool.

// apiResultBudget bounds what one bridged call returns to the client.
const apiResultBudget = 24000

// writeScopes are the scopes that let a connection change anything.
var writeScopes = []string{auth.ScopeTicketsWrite, auth.ScopeContactsWrite, auth.ScopeKBWrite, auth.ScopeChangelogWrite,
	auth.ScopeWikiWrite, auth.ScopeSettingsWrite}

func apiTools() []*tool {
	queryProp := map[string]any{"type": "object", "description": `Query parameters by name, such as {"limit": 20}.`,
		"additionalProperties": map[string]any{"type": []any{"string", "number", "boolean", "array"}}}
	bodyProp := map[string]any{"type": []any{"object", "array"}, "description": "The JSON request body, as describe_api documents it."}
	pathProp := str("The concrete path with ids filled in, such as /v1/tickets/3f2c.../tags. No query string.")
	return []*tool{
		{
			Name: "find_api", Title: "Find API routes", ReadOnly: true, Idempotent: true,
			Description: "Find opendesk API routes by keywords, covering everything the app can do: tickets, messages, views, macros (saved replies), " +
				"automations, SLA, routing, teams, members, mailboxes, brands, widgets, bots, labels, custom fields, the knowledge base, " +
				"the wiki, changelog, reports, phone calls, integrations and more. Use it when no other tool covers a task, then describe_api " +
				"for the parameters and body, then api_read or api_write. With no query and no area it lists the API's areas.",
			Schema: obj(map[string]any{
				"query":  strN("Keywords, such as 'saved reply' or 'merge tickets'.", 1, 200),
				"area":   strN("Only routes of this area, from the area list.", 1, 60),
				"offset": integer("next_offset from a previous result.", 0, 10000, 0),
			}),
			Run: findAPI,
		},
		{
			Name: "describe_api", Title: "Describe an API route", ReadOnly: true, Idempotent: true,
			Description: "Describe one API route found with find_api: what it does, its path and query parameters, its JSON body and what it returns.",
			Schema: obj(map[string]any{
				"method": enum("The HTTP method.", "GET", "POST", "PUT", "PATCH", "DELETE"),
				"path":   str("The route's path, as a template (/v1/tickets/{id}) or concrete (/v1/tickets/3f2c...)."),
			}, "method", "path"),
			Run: describeAPI,
		},
		{
			Name: "api_read", Title: "Read through the API", ReadOnly: true, Idempotent: true,
			Description: "Call a read-only opendesk API route (a GET) as this connection, with its permissions. Look the route up with " +
				"find_api and describe_api first. Returns the JSON response; lists are paged with limit and cursor.",
			Schema: obj(map[string]any{"path": pathProp, "query": queryProp}, "path"),
			Run:    callAPI(kindRead),
		},
		{
			Name: "api_write", Title: "Change through the API", Destructive: true, OpenWorld: true,
			Offer: func(p *auth.Principal) bool {
				for _, s := range writeScopes {
					if p.HasScope(s) {
						return true
					}
				}
				return false
			},
			Description: "Call an opendesk API route that changes data (POST, PUT, PATCH or DELETE) as this connection, with its permissions. " +
				"Prefer a dedicated tool when one exists. Look the route up with find_api and describe_api first and send exactly the documented body. " +
				"Some routes send email or delete for good, as they do in the app.",
			Schema: obj(map[string]any{
				"method": enum("The HTTP method.", "POST", "PUT", "PATCH", "DELETE"),
				"path":   pathProp,
				"query":  queryProp,
				"body":   bodyProp,
			}, "method", "path"),
			Run: callAPI(kindWrite),
		},
	}
}

func findAPI(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Query  string `json:"query"`
		Area   string `json:"area"`
		Offset int    `json:"offset"`
	}](raw)
	if err != nil {
		return nil, err
	}
	cat, err := c.srv.catalog()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Query) == "" && strings.TrimSpace(a.Area) == "" {
		type area struct {
			Area   string `json:"area"`
			Routes int    `json:"routes"`
		}
		var areas []area
		for tag, n := range cat.areas() {
			areas = append(areas, area{tag, n})
		}
		sort.Slice(areas, func(i, j int) bool { return areas[i].Area < areas[j].Area })
		return map[string]any{"areas": areas, "hint": "Search with keywords, or pass an area to list its routes."}, nil
	}
	return cat.search(a.Query, strings.TrimSpace(a.Area), a.Offset, 15), nil
}

func describeAPI(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	}](raw)
	if err != nil {
		return nil, err
	}
	cat, err := c.srv.catalog()
	if err != nil {
		return nil, err
	}
	op := cat.find(a.Method, a.Path)
	if op == nil {
		var merr error
		if op, _, merr = cat.match(a.Method, a.Path); merr != nil {
			return nil, invalid(merr.Error())
		}
	}
	return cat.describe(op), nil
}

// callAPI runs one documented route of kind as the caller.
func callAPI(kind apiKind) func(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	return func(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
		a, err := decode[struct {
			Method string          `json:"method"`
			Path   string          `json:"path"`
			Query  map[string]any  `json:"query"`
			Body   json.RawMessage `json:"body"`
		}](raw)
		if err != nil {
			return nil, err
		}
		method := strings.ToUpper(strings.TrimSpace(a.Method))
		if kind == kindRead {
			method = http.MethodGet
		}
		cat, err := c.srv.catalog()
		if err != nil {
			return nil, err
		}
		op, target, err := cat.match(method, a.Path)
		if err != nil {
			return nil, invalid(err.Error())
		}
		if op.Unavailable != "" {
			return nil, invalid(op.key() + " is not available here: " + op.Unavailable)
		}
		if op.Kind != kind {
			if kind == kindRead {
				return nil, invalid(op.key() + " changes data; call it with api_write")
			}
			return nil, invalid(op.key() + " only reads; call it with api_read")
		}
		query, err := queryValues(a.Query)
		if err != nil {
			return nil, err
		}
		var body []byte
		contentType := ""
		if b := strings.TrimSpace(string(a.Body)); b != "" && b != "null" {
			if kind == kindRead {
				return nil, invalid("api_read takes no body; pass filters in query")
			}
			body, contentType = a.Body, "application/json"
		}
		resp, err := c.send(ctx, method, target, query, contentType, body)
		if err != nil {
			return nil, err
		}
		return apiResult(resp), nil
	}
}

func queryValues(in map[string]any) (url.Values, error) {
	out := url.Values{}
	for k, v := range in {
		switch x := v.(type) {
		case string:
			out.Set(k, x)
		case bool:
			out.Set(k, strconv.FormatBool(x))
		case float64:
			out.Set(k, strconv.FormatFloat(x, 'f', -1, 64))
		case []any:
			for _, e := range x {
				out.Add(k, fmt.Sprint(e))
			}
		case nil:
		default:
			return nil, invalid(fmt.Sprintf("query parameter %q must be a string, number, boolean or list", k))
		}
	}
	return out, nil
}

// apiResult is a bridged response as the tool returns it: the JSON with credential-shaped
// members withheld, cut to apiResultBudget.
func apiResult(resp []byte) any {
	if len(strings.TrimSpace(string(resp))) == 0 {
		return map[string]any{"ok": true}
	}
	var parsed any
	if json.Unmarshal(resp, &parsed) != nil {
		return map[string]any{"ok": true, "text": clip(string(resp), apiResultBudget)}
	}
	parsed = redact(parsed)
	b, _ := json.Marshal(parsed)
	if len(b) <= apiResultBudget {
		return json.RawMessage(b)
	}
	return map[string]any{"truncated": true, "hint": "The response was too long; ask for fewer results with limit or filters.",
		"json": string(b[:apiResultBudget])}
}

// redact withholds credential-shaped members, so no secret a route returns reaches the client.
func redact(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if s, ok := e.(string); ok && s != "" && secretField(k) {
				x[k] = "[withheld]"
				continue
			}
			x[k] = redact(e)
		}
	case []any:
		for i, e := range x {
			x[i] = redact(e)
		}
	}
	return v
}
