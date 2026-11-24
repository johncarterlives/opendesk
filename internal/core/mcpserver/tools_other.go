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

	"github.com/useopendesk/opendesk/internal/ai"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// --- knowledge -----------------------------------------------------------------------

// Passage is a piece of a knowledge source (website page, file, snippet) that matched a
// search (contracts/agent.md, "Knowledge sources").
type Passage struct {
	SourceID string `json:"source_id"`
	Kind     string `json:"kind"`
	Title    string `json:"title"`
	URL      string `json:"url,omitempty"`
	Text     string `json:"text"`
}

// SearchSources finds passages in the workspace's knowledge sources for search_knowledge.
// It is called with the API key's principal (workspace and scopes) and must scope its
// reads to p.WorkspaceID. Until it is set, search_knowledge answers from KB articles only.
var SearchSources func(ctx context.Context, p *auth.Principal, query string, limit int) ([]Passage, error)

func knowledgeTools() []*tool {
	return []*tool{
		{
			Name: "search_knowledge", Title: "Search the knowledge base", Scopes: []string{auth.ScopeKBRead}, ReadOnly: true, Idempotent: true,
			Description: "Search the help center's knowledge base articles and the workspace's other knowledge sources by text. " +
				"Returns the best matches, the top ones with their full text, to answer questions or cite in replies.",
			Schema: obj(map[string]any{
				"query":  strN("What to search for.", 1, 200),
				"status": enum("Which articles: published (the default), draft or any.", "published", "draft", "any"),
				"limit":  integer("How many articles to return.", 1, 10, 5),
			}, "query"),
			Run: searchKnowledge,
		},
		{
			Name: "create_kb_draft", Title: "Create a draft article", Scopes: []string{auth.ScopeKBWrite},
			Description: "Create a knowledge base article as an unpublished draft for the team to review and publish. Markdown body.",
			Schema: obj(map[string]any{
				"title":         strN("The article title.", 1, 200),
				"body":          strN("The article, in markdown.", 1, 50000),
				"collection_id": str("Put the draft in this collection (optional)."),
			}, "title", "body"),
			Run: createKBDraft,
		},
	}
}

// Full text is returned for the top fullTextArticles matches.
const (
	fullTextArticles = 3
	articleChars     = 6000
)

type apiArticle struct {
	ID           string     `json:"id"`
	CollectionID *string    `json:"collection_id"`
	Title        string     `json:"title"`
	Slug         string     `json:"slug"`
	Excerpt      string     `json:"excerpt"`
	BodyHTML     string     `json:"body_html"`
	Status       string     `json:"status"`
	PublishedAt  *time.Time `json:"published_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

type outArticle struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Slug         string    `json:"slug"`
	Status       string    `json:"status"`
	CollectionID *string   `json:"collection_id,omitempty"`
	Excerpt      string    `json:"excerpt,omitempty"`
	Text         string    `json:"text,omitempty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func searchKnowledge(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Query  string `json:"query"`
		Status string `json:"status"`
		Limit  int    `json:"limit"`
	}](raw)
	if err != nil {
		return nil, err
	}
	query := strings.TrimSpace(a.Query)
	if query == "" {
		return nil, invalid("query is empty")
	}
	query = clip(query, 200)
	if err := oneOf(a.Status, "status", "published", "draft", "any"); err != nil {
		return nil, err
	}
	limit := a.Limit
	if limit <= 0 {
		limit = 5
	}
	limit = min(limit, 10)
	q := url.Values{"q": {query}, "limit": {strconv.Itoa(limit)}}
	switch a.Status {
	case "", "published":
		q.Set("status", "published")
	case "draft":
		q.Set("status", "draft")
	}
	var pg page[apiArticle]
	if err := c.get(ctx, "/v1/kb/articles", q, &pg); err != nil {
		return nil, err
	}
	out := struct {
		Articles []outArticle `json:"articles"`
		Sources  []Passage    `json:"sources,omitempty"`
	}{Articles: []outArticle{}}
	for i, ar := range pg.Data {
		o := outArticle{ID: ar.ID, Title: ar.Title, Slug: ar.Slug, Status: ar.Status, CollectionID: ar.CollectionID, UpdatedAt: ar.UpdatedAt}
		if i < fullTextArticles {
			o.Text = clip(hd.HTMLToText(ar.BodyHTML), articleChars)
		} else {
			o.Excerpt = clip(ar.Excerpt, 300)
		}
		out.Articles = append(out.Articles, o)
	}
	if SearchSources != nil {
		ps, err := SearchSources(ctx, c.p, query, limit)
		if err != nil {
			return nil, err
		}
		for _, p := range ps {
			p.Text = clip(p.Text, articleChars)
			out.Sources = append(out.Sources, p)
		}
	}
	return out, nil
}

func createKBDraft(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Title        string `json:"title"`
		Body         string `json:"body"`
		CollectionID string `json:"collection_id"`
	}](raw)
	if err != nil {
		return nil, err
	}
	title := strings.Join(strings.Fields(a.Title), " ")
	if title == "" || utf8.RuneCountInString(title) > 200 {
		return nil, invalid("title must be 1 to 200 characters")
	}
	body := strings.TrimSpace(a.Body)
	if body == "" || utf8.RuneCountInString(body) > 50000 {
		return nil, invalid("body must be 1 to 50,000 characters")
	}
	req := map[string]any{"title": title, "body_html": ai.MarkdownToHTML(body), "status": "draft"}
	if a.CollectionID != "" {
		id, err := idRef(a.CollectionID, "collection_id")
		if err != nil {
			return nil, err
		}
		req["collection_id"] = id
	}
	var ar apiArticle
	if err := c.do(ctx, http.MethodPost, "/v1/kb/articles", nil, req, &ar); err != nil {
		return nil, err
	}
	return outArticle{ID: ar.ID, Title: ar.Title, Slug: ar.Slug, Status: ar.Status, CollectionID: ar.CollectionID, UpdatedAt: ar.UpdatedAt}, nil
}

// --- reports -------------------------------------------------------------------------

func reportTools() []*tool {
	return []*tool{
		{
			// The overview route reads tickets, so the key needs tickets:read as well.
			Name: "get_report", Title: "Get the overview report", Scopes: []string{auth.ScopeSettingsRead, auth.ScopeTicketsRead}, ReadOnly: true, Idempotent: true,
			Description: "Helpdesk numbers for a date range: tickets created and solved, open now, median first response and resolution minutes, " +
				"CSAT, SLA breaches, and breakdowns by day, channel, severity and agent. Defaults to the last 30 days.",
			Schema: obj(map[string]any{
				"from": str("First day, YYYY-MM-DD in the workspace's timezone (default 30 days ago)."),
				"to":   str("Last day, inclusive, YYYY-MM-DD (default today)."),
			}),
			Run: getReport,
		},
	}
}

// reportDays is the most daily rows returned; the totals carry the answer.
const reportDays = 92

func getReport(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		From string `json:"from"`
		To   string `json:"to"`
	}](raw)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	for k, v := range map[string]string{"from": a.From, "to": a.To} {
		if v = strings.TrimSpace(v); v != "" {
			if _, err := day(v, k, false); err != nil {
				return nil, err
			}
			q.Set(k, v)
		}
	}
	var rep map[string]any
	if err := c.get(ctx, "/v1/reports/overview", q, &rep); err != nil {
		return nil, err
	}
	if days, ok := rep["by_day"].([]any); ok && len(days) > reportDays {
		rep["by_day"] = days[len(days)-reportDays:]
		rep["by_day_note"] = "the last " + strconv.Itoa(reportDays) + " days of the range"
	}
	if from, to := a.From, a.To; from != "" || to != "" {
		rep["range"] = map[string]string{"from": from, "to": to}
	}
	return rep, nil
}
