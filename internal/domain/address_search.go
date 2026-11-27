package domain

import (
	"regexp"
	"strings"
	"unicode"
)

// Address search (contracts/api.md "Search"): a query that is one address-like word finds the
// tickets whose customer has a matching address, primary or extra, or one of whose messages is
// from, to or cc'd one. Addresses are searched as words (address_words, migration 000775): split
// at "@", dots, plus signs, underscores and hyphens. Each lookup reads its own GIN index.

var (
	addressChars = regexp.MustCompile(`^[\p{L}\p{N}@.+_-]+$`)
	addressWord  = regexp.MustCompile(`[\p{L}\p{N}]+`)
	domainLike   = regexp.MustCompile(`^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$`)
)

// AddressQuery is the to_tsquery text that finds q among addresses: q's words in order as a
// phrase, the last also as a prefix, so "buyer@example.com", "example.com", "example" and "buy"
// all find buyer@example.com. It is "" when q is not one address-like word: it has spaces or
// other punctuation, or no letter.
func AddressQuery(q string) string {
	q = strings.ToLower(strings.TrimSpace(q))
	if len(q) < 2 || len(q) > 254 || !addressChars.MatchString(q) || !strings.ContainsFunc(q, unicode.IsLetter) {
		return ""
	}
	words := addressWord.FindAllString(q, 16)
	if len(words) == 0 {
		return ""
	}
	words[len(words)-1] += ":*"
	return strings.Join(words, " <-> ")
}

// LooksLikeAddress is whether q is an email address or a domain, such as "buyer@example.com" or
// "example.com": what a person types to find one sender's mail.
func LooksLikeAddress(q string) bool {
	q = strings.TrimSpace(q)
	if AddressQuery(q) == "" {
		return false
	}
	if at := strings.LastIndexByte(q, '@'); at >= 0 {
		return at > 0 && at < len(q)-1
	}
	return domainLike.MatchString(q)
}

func addressTsquery(arg string) string { return "to_tsquery('simple', " + arg + ")" }

// ContactAddressSQL is a condition on a contact (alias c): one of its addresses, primary or
// extra, matches the AddressQuery in the placeholder arg.
func ContactAddressSQL(c, arg string) string {
	tq := addressTsquery(arg)
	return `(address_words(ARRAY[` + c + `.email::text]) @@ ` + tq + ` OR EXISTS (SELECT 1 FROM contact_emails cax
		WHERE cax.workspace_id = ` + c + `.workspace_id AND cax.contact_id = ` + c + `.id AND address_words(ARRAY[cax.email::text]) @@ ` + tq + `))`
}

// AddressTicketsSQL selects the ids of the tickets of workspace ws (a placeholder) that the
// AddressQuery in the placeholder arg finds: by their contact's addresses and their messages'
// from, to and cc. Callers apply deletion, spam and private-team visibility themselves.
func AddressTicketsSQL(ws, arg string) string {
	tq := addressTsquery(arg)
	return `SELECT am.ticket_id FROM messages am WHERE am.workspace_id = ` + ws + ` AND am.deleted_at IS NULL
			AND address_words(array_prepend(am.from_email, am.to_emails || am.cc_emails)) @@ ` + tq + `
		UNION SELECT act.id FROM contacts ac JOIN tickets act ON act.workspace_id = ac.workspace_id AND act.contact_id = ac.id
			WHERE ac.workspace_id = ` + ws + ` AND address_words(ARRAY[ac.email::text]) @@ ` + tq + `
		UNION SELECT axt.id FROM contact_emails ax JOIN tickets axt ON axt.workspace_id = ax.workspace_id AND axt.contact_id = ax.contact_id
			WHERE ax.workspace_id = ` + ws + ` AND address_words(ARRAY[ax.email::text]) @@ ` + tq
}
