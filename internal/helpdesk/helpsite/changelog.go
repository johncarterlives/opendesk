package helpsite

import (
	"context"
	"encoding/xml"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
)

// Changelog sizes: a page of the timeline, the home page's latest updates, the entries an
// entry page suggests next, and the feed.
const (
	changelogPerPage = 10
	changelogMaxPage = 1000
	latestLimit      = 3
	moreEntries      = 4
	feedLimit        = 30
)

// changelogData is the timeline page.
type changelogData struct {
	Entries    []entryView
	Categories []string
	Category   string // the category it shows, or "" for every one
	Page       int
	Newer      string // the newer page's URL, or ""
	Older      string // the older page's URL, or ""
}

// entryView is an entry as a page shows it.
type entryView struct {
	kb.ChangelogEntry
	Body template.HTML
}

// changelogURL is the timeline, narrowed to category and at page n, in the reader's language.
func (p *page) changelogURL(category string, n int) string {
	q := url.Values{}
	if category != "" {
		q.Set("category", category)
	}
	if n > 1 {
		q.Set("page", strconv.Itoa(n))
	}
	if p.langQ != "" {
		q.Set("lang", p.Lang)
	}
	u := p.base + "/changelog"
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return u
}

// CategoryURL is the timeline of one category; "" is every category.
func (p *page) CategoryURL(category string) string { return p.changelogURL(category, 1) }

// FeedURL is the changelog's Atom feed.
func (p *page) FeedURL() string { return p.base + "/changelog/feed.xml" }

// Dated is the date an entry carries.
func (p *page) Dated(e kb.ChangelogEntry) time.Time {
	if e.PublishedAt != nil {
		return *e.PublishedAt
	}
	return e.UpdatedAt
}

func (s *Server) entryView(e kb.ChangelogEntry) entryView {
	return entryView{ChangelogEntry: e, Body: articleBody(e.BodyHTML, strings.TrimRight(s.d.Cfg.APIURL, "/"))}
}

func (s *Server) changelog(ctx context.Context, p *page, hc kb.HelpCenter, query url.Values) error {
	category := strings.Join(strings.Fields(query.Get("category")), " ")
	if len([]rune(category)) > 64 {
		return errNotFound
	}
	n, _ := strconv.Atoi(query.Get("page"))
	if n < 1 {
		n = 1
	}
	if n > changelogMaxPage {
		return errNotFound
	}
	entries, more, err := kb.Changelog(ctx, s.d.DB.Pool, hc, category, (n-1)*changelogPerPage, changelogPerPage)
	if err != nil {
		return err
	}
	if len(entries) == 0 && n > 1 {
		return errNotFound
	}
	cats, err := kb.ChangelogCategories(ctx, s.d.DB.Pool, hc)
	if err != nil {
		return err
	}
	p.Kind = "changelog"
	p.path = "/changelog"
	c := &changelogData{Categories: cats, Category: category, Page: n}
	for _, e := range entries {
		c.Entries = append(c.Entries, s.entryView(e))
	}
	p.Changelog = c
	if n > 1 {
		c.Newer = p.changelogURL(category, n-1)
	}
	if more {
		c.Older = p.changelogURL(category, n+1)
	}
	// An empty timeline, or one narrowed to a category, is not a page of its own for search engines.
	p.NoIndex = len(entries) == 0 || category != ""
	s.languages(p)
	title := p.T.T("help.changelog")
	p.finish(title, p.T.T("help.changelog_subtitle"), map[string]any{"@context": "https://schema.org", "@type": "BreadcrumbList",
		"itemListElement": breadcrumbs(p, crumb{title, p.base + p.path})})
	return nil
}

var firstImage = regexp.MustCompile(`<img[^>]+src="(https?://[^"]+)"`)

func (s *Server) entry(ctx context.Context, p *page, hc kb.HelpCenter, slug string) error {
	e, err := kb.ChangelogEntryBySlug(ctx, s.d.DB.Pool, hc, slug)
	if err != nil {
		return err
	}
	v := s.entryView(e)
	p.Kind = "entry"
	p.path = "/changelog/" + e.Slug
	p.Entry = &v
	p.OGType = "article"
	if m := firstImage.FindStringSubmatch(string(v.Body)); m != nil {
		p.Site.Image = strings.ReplaceAll(m[1], "&amp;", "&")
		p.LargeCard = true
	}
	latest, _, err := kb.Changelog(ctx, s.d.DB.Pool, hc, "", 0, moreEntries+1)
	if err != nil {
		return err
	}
	for _, x := range latest {
		if x.ID != e.ID && len(p.MoreEntries) < moreEntries {
			p.MoreEntries = append(p.MoreEntries, x)
		}
	}
	s.languages(p)
	desc := e.Excerpt
	if desc == "" {
		desc = excerpt(stripTags(e.BodyHTML), 200)
	}
	post := map[string]any{"@type": "BlogPosting", "headline": e.Title, "description": excerpt(desc, 160), "dateModified": p.ISO(e.UpdatedAt),
		"datePublished": p.ISO(p.Dated(e)), "mainEntityOfPage": p.base + p.path, "inLanguage": p.defLang,
		"publisher": map[string]any{"@type": "Organization", "name": p.Site.Title}}
	if len(e.Categories) > 0 {
		post["keywords"] = strings.Join(e.Categories, ", ")
	}
	if p.LargeCard {
		post["image"] = p.Site.Image
	}
	if e.Author != nil && e.Author.Name != "" {
		post["author"] = map[string]any{"@type": "Person", "name": e.Author.Name}
	}
	title := p.T.T("help.changelog")
	p.finish(e.Title, desc, map[string]any{"@context": "https://schema.org", "@graph": []any{post,
		map[string]any{"@type": "BreadcrumbList", "itemListElement": breadcrumbs(p, crumb{title, p.base + "/changelog"}, crumb{e.Title, p.base + p.path})}}})
	return nil
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr,omitempty"`
	Type string `xml:"type,attr,omitempty"`
}

type atomText struct {
	Type string `xml:"type,attr,omitempty"`
	Body string `xml:",chardata"`
}

type atomPerson struct {
	Name string `xml:"name"`
}

type atomCategory struct {
	Term string `xml:"term,attr"`
}

type atomEntry struct {
	ID         string         `xml:"id"`
	Title      string         `xml:"title"`
	Link       atomLink       `xml:"link"`
	Published  string         `xml:"published"`
	Updated    string         `xml:"updated"`
	Authors    []atomPerson   `xml:"author"`
	Categories []atomCategory `xml:"category"`
	Summary    string         `xml:"summary,omitempty"`
	Content    atomText       `xml:"content"`
}

type atomFeed struct {
	XMLName  xml.Name    `xml:"feed"`
	NS       string      `xml:"xmlns,attr"`
	ID       string      `xml:"id"`
	Title    string      `xml:"title"`
	Subtitle string      `xml:"subtitle,omitempty"`
	Updated  string      `xml:"updated"`
	Links    []atomLink  `xml:"link"`
	Author   atomPerson  `xml:"author"`
	Icon     string      `xml:"icon,omitempty"`
	Entries  []atomEntry `xml:"entry"`
}

// feed answers the changelog's Atom feed: the latest entries with their whole bodies.
func (s *Server) feed(w http.ResponseWriter, r *http.Request, hc kb.HelpCenter, p *page) {
	entries, _, err := kb.Changelog(r.Context(), s.d.DB.Pool, hc, "", 0, feedLimit)
	if err != nil {
		s.d.Log.Error("help center feed", "err", err)
		http.Error(w, "Something went wrong. Please try again.", http.StatusInternalServerError)
		return
	}
	stamp := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	page := p.base + "/changelog"
	f := atomFeed{NS: "http://www.w3.org/2005/Atom", ID: page, Title: hc.Title + " · " + p.T.T("help.changelog"),
		Subtitle: p.T.T("help.changelog_subtitle"), Author: atomPerson{Name: hc.Title}, Icon: p.Site.Logo,
		Links: []atomLink{{Href: p.FeedURL(), Rel: "self", Type: "application/atom+xml"}, {Href: page, Rel: "alternate", Type: "text/html"}}}
	var newest time.Time
	for _, e := range entries {
		u := page + "/" + url.PathEscape(e.Slug)
		x := atomEntry{ID: u, Title: e.Title, Link: atomLink{Href: u, Rel: "alternate", Type: "text/html"},
			Published: stamp(p.Dated(e)), Updated: stamp(e.UpdatedAt), Summary: e.Excerpt,
			Content: atomText{Type: "html", Body: string(articleBody(e.BodyHTML, strings.TrimRight(s.d.Cfg.APIURL, "/")))}}
		if e.Author != nil && e.Author.Name != "" {
			x.Authors = []atomPerson{{Name: e.Author.Name}}
		}
		for _, c := range e.Categories {
			x.Categories = append(x.Categories, atomCategory{Term: c})
		}
		f.Entries = append(f.Entries, x)
		if e.UpdatedAt.After(newest) {
			newest = e.UpdatedAt
		}
	}
	if newest.IsZero() {
		newest = time.Unix(0, 0)
	}
	f.Updated = stamp(newest)
	w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=600")
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, xml.Header)
	_ = xml.NewEncoder(w).Encode(f)
}
