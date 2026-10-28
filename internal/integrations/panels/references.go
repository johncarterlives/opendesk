package panels

import (
	"context"
	"errors"
	"regexp"
	"regexp/syntax"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/useopendesk/opendesk/internal/domain"
)

// DefaultReferencePattern finds what reads as an order or invoice number: a # and 3 digits or
// more (#1042), or 1 to 4 capital letters, an optional - or /, an optional year or other group
// of 2 to 4 digits and a separator, then 3 digits or more (S00042, SO-2026-0042, INV/2026/00012,
// PO4471). It needs the # or the letters, so years, prices, postcodes and phone numbers are not
// references.
const DefaultReferencePattern = `#\d{3,}\b|\b[A-Z]{1,4}[-/]?(?:\d{2,4}[-/])?\d{3,}\b`

const (
	// maxReferences bounds what one request carries, and maxReferenceLen each one.
	maxReferences   = 10
	maxReferenceLen = 64
	// maxPatternLen bounds a workspace's pattern, and maxPatternInsts its compiled program: RE2
	// scans in time linear in the text times the program.
	maxPatternLen   = 200
	maxPatternInsts = 64
	// referenceMessages is how many of the ticket's newest messages are read, maxScannedText
	// how much of each, maxScannedTotal how much of the subject and messages together, and
	// maxMatches how many matches are read in all (each search may read to the end of its text).
	referenceMessages = 50
	maxScannedText    = 20000
	maxScannedTotal   = 100000
	maxMatches        = 20
	// maxContactEmails bounds contact.emails.
	maxContactEmails = 5
)

// compilePattern checks a workspace's pattern: RE2 syntax, at most 200 characters, a program of
// at most 64 instructions, and it must not match an empty text (it would find a reference
// everywhere).
func compilePattern(p string) (*regexp.Regexp, error) {
	if len(p) > maxPatternLen {
		return nil, errors.New("The reference pattern is longer than 200 characters.")
	}
	re, err := regexp.Compile(p)
	if err != nil {
		return nil, errors.New("The reference pattern is not a valid regular expression (RE2 syntax).")
	}
	if patternInsts(p) > maxPatternInsts {
		return nil, errors.New("The reference pattern is too complex: use fewer or smaller repeat counts.")
	}
	if re.MatchString("") {
		return nil, errors.New("The reference pattern matches an empty text: it would find a reference everywhere.")
	}
	return re, nil
}

// patternInsts is the size of the program regexp.Compile builds for p: parsed with the same
// flags, simplified, then compiled.
func patternInsts(p string) int {
	re, err := syntax.Parse(p, syntax.Perl)
	if err != nil {
		return 0
	}
	prog, err := syntax.Compile(re.Simplify())
	if err != nil {
		return 0
	}
	return len(prog.Inst)
}

// normalizePattern checks a pattern an admin saves: the default is stored as NULL, so a later
// default applies to the panel by itself; "" finds no reference.
func normalizePattern(p string) (*string, error) {
	p = strings.TrimSpace(p)
	if p == DefaultReferencePattern {
		return nil, nil
	}
	if p != "" {
		if _, err := compilePattern(p); err != nil {
			return nil, err
		}
	}
	return &p, nil
}

// findReferences is what re finds in texts, in order, each once: the first group when the
// pattern has one, else the whole match. At most maxReferences, from the first maxScannedText
// characters of each text, maxScannedTotal in all, and the first maxMatches matches.
func findReferences(re *regexp.Regexp, texts ...string) []string {
	out := []string{}
	seen := map[string]bool{}
	scan, matches := maxScannedTotal, maxMatches
	for _, text := range texts {
		if scan == 0 || matches == 0 {
			break
		}
		if r := []rune(text); len(r) > min(maxScannedText, scan) {
			text = string(r[:min(maxScannedText, scan)])
		}
		scan -= utf8.RuneCountInString(text)
		found := re.FindAllStringSubmatch(text, matches)
		matches -= len(found)
		for _, m := range found {
			ref := m[0]
			if len(m) > 1 {
				ref = m[1]
			}
			ref = cleanText(ref, maxReferenceLen)
			if ref == "" || seen[ref] {
				continue
			}
			seen[ref] = true
			out = append(out, ref)
			if len(out) == maxReferences {
				return out
			}
		}
	}
	return out
}

// referencePattern is the pattern the panel finds references with; "" finds none.
func (x *row) referencePattern() string {
	if x.RefPattern == nil {
		return DefaultReferencePattern
	}
	return *x.RefPattern
}

// ticketContext is what an http panel's request carries beyond the ticket: the references found in
// its subject and newest messages (never their text), every address the contact wrote from and the
// contact's phone.
type ticketContext struct {
	References []string
	Emails     []string
	Phone      string
}

// lookupContext reads the ticket's context for the panel.
func (s *Service) lookupContext(ctx context.Context, x *row, t *domain.Ticket, sub subject) (ticketContext, error) {
	c := ticketContext{References: []string{}, Emails: []string{}}
	if sub.Email != "" {
		c.Emails = []string{sub.Email}
	}
	if sub.ContactID != nil {
		if err := s.d.DB.Pool.QueryRow(ctx, `SELECT phone FROM contacts WHERE workspace_id = $1 AND id = $2`,
			x.WorkspaceID, *sub.ContactID).Scan(&c.Phone); err != nil {
			return c, err
		}
		c.Phone = cleanText(c.Phone, 50)
	}
	// Only messages every reader of the ticket reads: never a deleted one or a note sent as a reply.
	rows, err := s.d.DB.Pool.Query(ctx, `SELECT left(m.body_text, $5), m.from_email, m.author_contact_id IS NOT DISTINCT FROM $3
		FROM messages m WHERE m.workspace_id = $1 AND m.ticket_id = $2 AND NOT `+domain.HiddenMessageSQL+`
		ORDER BY m.created_at DESC LIMIT $4`, x.WorkspaceID, t.ID, sub.ContactID, referenceMessages, maxScannedText)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	texts := []string{t.Subject}
	for rows.Next() {
		var body, from string
		var byContact bool
		if err := rows.Scan(&body, &from, &byContact); err != nil {
			return c, err
		}
		texts = append(texts, body)
		from = strings.ToLower(strings.TrimSpace(from))
		if byContact && sub.ContactID != nil && from != "" && len(c.Emails) < maxContactEmails && !slices.Contains(c.Emails, from) {
			c.Emails = append(c.Emails, from)
		}
	}
	if err := rows.Err(); err != nil {
		return c, err
	}
	if p := x.referencePattern(); p != "" {
		re, err := compilePattern(p)
		if err != nil {
			return c, nil // checked when saved; a pattern that no longer compiles finds nothing
		}
		c.References = findReferences(re, texts...)
	}
	return c, nil
}
