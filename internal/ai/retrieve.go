package ai

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

// Relevance thresholds. Cosine similarity for embeddings; keyword coverage (share of
// the query's meaningful words found in the article) for full-text fallback.
const (
	minSimilarityDraft  = 0.30
	minSimilarityAnswer = 0.45
	minCoverageDraft    = 0.34
	minCoverageAnswer   = 0.5
	passageChars        = 2400
)

var queryWord = regexp.MustCompile(`[\p{L}\p{N}]+`)

// stopwords are dropped from keyword queries (English plus the commonest of a few
// other languages); the 'simple' text search configuration keeps every word.
var stopwords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`a an and are as at be but by can could did do does for from had has have how i if in into is it its
		me my no not of on or our please so that the their them then there they this to was we were what when where which who why will
		with would you your hi hello thanks thank hey can't cannot im i'm get got want need help
		der die das und ist ich nicht ein eine mit wie was zu den dem es sie wir bitte hallo danke
		le la les et est je pas un une avec comment pour de des du que qui bonjour merci
		el los las y es yo no una con como para que por hola gracias
		il lo gli che non per una ciao grazie
		o os as e não um uma com como para por olá obrigado`) {
		stopwords[w] = true
	}
}

// keywords are the meaningful lowercased words of a query, deduplicated, at most 12.
func keywords(q string) []string {
	var out []string
	seen := map[string]bool{}
	for _, w := range queryWord.FindAllString(strings.ToLower(q), 64) {
		if utf8.RuneCountInString(w) < 2 || stopwords[w] || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
		if len(out) == 12 {
			break
		}
	}
	return out
}

// orQuery is a prefix tsquery matching any keyword ("reset:* | password:*").
func orQuery(words []string) string {
	parts := make([]string, len(words))
	for i, w := range words {
		parts[i] = stem(w) + ":*"
	}
	return strings.Join(parts, " | ")
}

// stem strips a few common inflections so "charged" matches "charge" and "refunds"
// matches "refund" under the 'simple' text search configuration. It is deliberately
// light: a prefix match on the stem does the rest.
func stem(w string) string {
	for _, suf := range []string{"ing", "ed", "es", "s", "ly"} {
		if strings.HasSuffix(w, suf) && utf8.RuneCountInString(w)-len(suf) >= 4 {
			return strings.TrimSuffix(w, suf)
		}
	}
	return w
}

// keywordHits counts the keywords present in text (prefix match on stems).
func keywordHits(words []string, text string) int {
	have := map[string]bool{}
	for _, w := range queryWord.FindAllString(strings.ToLower(text), -1) {
		have[w] = true
	}
	hit := 0
	for _, k := range words {
		if have[k] {
			hit++
			continue
		}
		s := stem(k)
		for w := range have {
			if strings.HasPrefix(w, s) || strings.HasPrefix(s, w) && utf8.RuneCountInString(w) >= 4 {
				hit++
				break
			}
		}
	}
	return hit
}

// coverage is the share of keywords present in text. Long messages (drafts answer a
// whole customer email) are judged on at most capWords keywords.
func coverage(words []string, text string, capWords int) float64 {
	if len(words) == 0 {
		return 0
	}
	return float64(keywordHits(words, text)) / float64(min(len(words), capWords))
}

// bestPassage picks the window of an article's text with the most keyword hits.
func bestPassage(text string, words []string, n int) string {
	r := []rune(text)
	if len(r) <= n {
		return text
	}
	best, bestScore := 0, -1
	step := n / 4
	for start := 0; start < len(r); start += step {
		end := min(start+n, len(r))
		window := strings.ToLower(string(r[start:end]))
		score := 0
		for _, w := range words {
			score += strings.Count(window, w)
		}
		if score > bestScore {
			best, bestScore = start, score
		}
		if end == len(r) {
			break
		}
	}
	return clip(string(r[best:]), n)
}

// The knowledge base is per brand (contracts/teams.md): an answer for a ticket of brand B
// draws on articles shared by every brand (no brand of their own or of their collection)
// and B's own, and links them on B's help center. An article takes its collection's brand
// when the collection has one.

// kbBrandJoin joins an article a to its brand eb (the collection's, else its own).
// kbArticlePath is an article's address on a help center, after the help center's own
// (kb.KbArticle.Path), with kbBrandJoin's collection kc.
const kbArticlePath = `COALESCE('/c/' || kc.slug || '/', '/a/') || a.slug`

const kbBrandJoin = ` LEFT JOIN kb_collections kc ON kc.workspace_id = a.workspace_id AND kc.id = a.collection_id
	LEFT JOIN brands eb ON eb.workspace_id = a.workspace_id AND eb.id = COALESCE(kc.brand_id, a.brand_id)`

// kbBrandSQL keeps the articles of brand $n (a nullable uuid) and the shared ones; a null
// brand keeps every article.
func kbBrandSQL(n int) string {
	return fmt.Sprintf(`($%[1]d::uuid IS NULL OR COALESCE(kc.brand_id, a.brand_id) IS NULL OR COALESCE(kc.brand_id, a.brand_id) = $%[1]d::uuid)`, n)
}

// kbBrandSlug is the help center slug links fall back to: the brand's, or without one the
// default brand's (the workspace slug when no brand row is found).
func (s *Service) kbBrandSlug(ctx context.Context, wid uuid.UUID, brand *uuid.UUID) (string, error) {
	var slug string
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT COALESCE(
			(SELECT b.slug FROM brands b WHERE b.workspace_id = $1 AND ($2::uuid IS NULL AND b.is_default OR b.id = $2::uuid) LIMIT 1),
			(SELECT w.slug FROM workspaces w WHERE w.id = $1))`, wid, brand).Scan(&slug)
	return slug, err
}

// ticketBrand is the brand a ticket's answers draw on, nil when unknown.
func ticketBrand(t domain.Ticket) *uuid.UUID {
	if t.BrandID == uuid.Nil {
		return nil
	}
	b := t.BrandID
	return &b
}

// retrieveKB returns the published articles of brand (nil: every brand) most relevant to
// query: embeddings when available, else full-text search. Results under minScore are
// dropped.
func (s *Service) retrieveKB(ctx context.Context, wid uuid.UUID, brand *uuid.UUID, query string, limit int, forAnswer bool) ([]kbSource, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	slug, err := s.kbBrandSlug(ctx, wid, brand)
	if err != nil {
		return nil, err
	}
	if s.semantic() {
		out, err := s.semanticKB(ctx, wid, brand, slug, query, limit, forAnswer)
		if err == nil && len(out) > 0 {
			return out, nil
		}
		if err != nil {
			s.d.Log.Warn("ai semantic retrieval failed, using full-text search", "err", err)
		}
	}
	return s.ftsKB(ctx, wid, brand, slug, query, limit, forAnswer)
}

func (s *Service) semanticKB(ctx context.Context, wid uuid.UUID, brand *uuid.UUID, slug, query string, limit int, forAnswer bool) ([]kbSource, error) {
	vecs, err := s.embedder.Embed(ctx, []string{clip(query, 4000)}, true)
	if err != nil {
		return nil, err
	}
	minSim := minSimilarityDraft
	if forAnswer {
		minSim = minSimilarityAnswer
	}
	rows, err := s.d.DB.Pool.Query(ctx, `SELECT a.id, a.title, `+kbArticlePath+`, COALESCE(eb.slug, $7), e.content, 1 - (e.embedding <=> $3::vector) AS sim
		FROM ai_embeddings e JOIN kb_articles a ON a.id = e.ref_id AND a.workspace_id = e.workspace_id`+kbBrandJoin+`
		WHERE e.workspace_id = $1 AND e.kind = 'article' AND e.model = $2 AND e.dims = $4 AND a.status = 'published' AND `+kbBrandSQL(6)+`
		ORDER BY e.embedding <=> $3::vector LIMIT $5`, wid, s.embedder.Model(), vectorLiteral(vecs[0]), len(vecs[0]), limit*4, brand, slug)
	if err != nil {
		return nil, err
	}
	type hit struct {
		id                              uuid.UUID
		title, path, brandSlug, passage string
		sim                             float64
	}
	hits, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (hit, error) {
		var h hit
		err := r.Scan(&h.id, &h.title, &h.path, &h.brandSlug, &h.passage, &h.sim)
		return h, err
	})
	if err != nil {
		return nil, err
	}
	hosts, err := s.helpHosts(ctx, wid)
	if err != nil {
		return nil, err
	}
	var out []kbSource
	idx := map[uuid.UUID]int{}
	for _, h := range hits {
		if h.sim < minSim {
			continue
		}
		if i, ok := idx[h.id]; ok {
			// A second strong chunk of the same article adds context.
			if utf8.RuneCountInString(out[i].Passage) < passageChars*2 {
				out[i].Passage += "\n…\n" + h.passage
			}
			continue
		}
		if len(out) == limit {
			continue
		}
		idx[h.id] = len(out)
		out = append(out, kbSource{ArticleID: h.id.String(), Title: h.title, URL: s.articleURL(hosts, h.brandSlug, h.path), Passage: h.passage, Score: h.sim})
	}
	return out, nil
}

func (s *Service) ftsKB(ctx context.Context, wid uuid.UUID, brand *uuid.UUID, slug, query string, limit int, forAnswer bool) ([]kbSource, error) {
	words := keywords(query)
	if len(words) == 0 {
		return nil, nil
	}
	hosts, err := s.helpHosts(ctx, wid)
	if err != nil {
		return nil, err
	}
	rows, err := s.d.DB.Pool.Query(ctx, `SELECT a.id, a.title, `+kbArticlePath+`, COALESCE(eb.slug, $5), a.excerpt, a.body_html
		FROM kb_articles a`+kbBrandJoin+`
		WHERE a.workspace_id = $1 AND a.status = 'published' AND a.search @@ to_tsquery('simple', $2) AND `+kbBrandSQL(4)+`
		ORDER BY ts_rank_cd(a.search, to_tsquery('simple', $2)) DESC, a.updated_at DESC LIMIT $3`, wid, orQuery(words), limit*3, brand, slug)
	if err != nil {
		return nil, err
	}
	type cand struct {
		src  kbSource
		cov  float64
		hits int
	}
	var cands []cand
	for rows.Next() {
		var id uuid.UUID
		var title, path, brandSlug, excerpt, body string
		if err := rows.Scan(&id, &title, &path, &brandSlug, &excerpt, &body); err != nil {
			rows.Close()
			return nil, err
		}
		text := hd.HTMLToText(body)
		capWords := 8
		if forAnswer {
			capWords = len(words)
		}
		hits := keywordHits(words, title+" "+excerpt+" "+text)
		cov := coverage(words, title+" "+excerpt+" "+text, capWords)
		cands = append(cands, cand{kbSource{ArticleID: id.String(), Title: title, URL: s.articleURL(hosts, brandSlug, path),
			Passage: bestPassage(text, words, passageChars), Score: min(cov, 1)}, cov, hits})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	minCov := minCoverageDraft
	if forAnswer {
		minCov = minCoverageAnswer
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].cov > cands[j].cov })
	var out []kbSource
	for _, c := range cands {
		// One keyword alone matches too much; require two unless the query has one.
		if c.cov < minCov || (len(words) > 1 && c.hits < 2) {
			continue
		}
		out = append(out, c.src)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

// --- Indexing ---------------------------------------------------------------------

// document is the text indexed for one article or ticket, and whether it should exist.
func (s *Service) document(ctx context.Context, q db.Querier, wid uuid.UUID, kind string, id uuid.UUID) (string, bool, error) {
	switch kind {
	case "article":
		var title, excerpt, body, status string
		err := q.QueryRow(ctx, `SELECT title, excerpt, body_html, status FROM kb_articles WHERE workspace_id = $1 AND id = $2`, wid, id).
			Scan(&title, &excerpt, &body, &status)
		if db.IsNotFound(err) || (err == nil && status != "published") {
			return "", false, nil
		}
		if err != nil {
			return "", false, err
		}
		return strings.TrimSpace(title + "\n\n" + excerpt + "\n\n" + hd.HTMLToText(body)), true, nil
	case "ticket":
		tc, err := s.loadTicketCtx(ctx, q, wid, id, true)
		if err != nil {
			if isNotFound(err) {
				return "", false, nil
			}
			return "", false, err
		}
		if tc.T.Spam {
			return "", false, nil
		}
		var b strings.Builder
		b.WriteString("Subject: " + tc.T.Subject + "\n")
		if tc.Summary != "" {
			b.WriteString("Summary: " + tc.Summary + "\n")
		}
		for _, m := range tc.Msgs {
			who := "Customer"
			if m.Direction == "outbound" {
				who = "Support"
			}
			b.WriteString("\n" + who + ": " + clip(messageText(m), 4000) + "\n")
		}
		return strings.TrimSpace(b.String()), true, nil
	}
	return "", false, nil
}

// maxTicketChunks bounds what one ticket costs to index.
const maxTicketChunks = 6

// Index (re)embeds one article or ticket. Unchanged content (same hash and model) is
// skipped; content that is gone or no longer eligible is removed.
func (s *Service) Index(ctx context.Context, wid uuid.UUID, kind string, id uuid.UUID) error {
	if !s.vectors {
		return nil
	}
	if kind != "article" && kind != "ticket" {
		return nil
	}
	text, ok, err := s.document(ctx, s.d.DB.Pool, wid, kind, id)
	if err != nil {
		return err
	}
	if !ok || text == "" || s.embedder == nil {
		_, err := s.d.DB.Pool.Exec(ctx, `DELETE FROM ai_embeddings WHERE workspace_id = $1 AND kind = $2 AND ref_id = $3`, wid, kind, id)
		return err
	}
	model := s.embedder.Model()
	hash := ContentHash(model, text)
	var current int
	if err := s.d.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM ai_embeddings WHERE workspace_id = $1 AND kind = $2 AND ref_id = $3
		AND model = $4 AND content_hash = $5`, wid, kind, id, model, hash).Scan(&current); err != nil {
		return err
	}
	if current > 0 {
		// Unchanged: mark the rows as checked so the backfill does not revisit them.
		_, err := s.d.DB.Pool.Exec(ctx, `UPDATE ai_embeddings SET created_at = now() WHERE workspace_id = $1 AND kind = $2 AND ref_id = $3`, wid, kind, id)
		return err
	}
	chunks := Chunk(text)
	if kind == "ticket" && len(chunks) > maxTicketChunks {
		chunks = chunks[:maxTicketChunks]
	}
	if kind == "article" && len(chunks) > 0 {
		// Every chunk carries the article title so it stands on its own.
		title := strings.SplitN(text, "\n", 2)[0]
		for i := 1; i < len(chunks); i++ {
			chunks[i] = title + "\n\n" + chunks[i]
		}
	}
	vecs, err := s.embedder.Embed(ctx, chunks, false)
	if err != nil {
		return err
	}
	return s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM ai_embeddings WHERE workspace_id = $1 AND kind = $2 AND ref_id = $3`, wid, kind, id); err != nil {
			return err
		}
		for i, c := range chunks {
			if _, err := tx.Exec(ctx, `INSERT INTO ai_embeddings (workspace_id, kind, ref_id, chunk, content_hash, model, dims, content, embedding)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`, wid, kind, id, i, hash, model, len(vecs[i]), c, vectorLiteral(vecs[i])); err != nil {
				return err
			}
		}
		return nil
	})
}

func isNotFound(err error) bool {
	if db.IsNotFound(err) {
		return true
	}
	var he interface{ GetStatus() int }
	if errors.As(err, &he) {
		return he.GetStatus() == 404
	}
	return false
}

func containsFold(list []string, s string) (string, bool) {
	i := slices.IndexFunc(list, func(v string) bool { return strings.EqualFold(v, s) })
	if i < 0 {
		return "", false
	}
	return list[i], true
}
