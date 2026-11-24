package email

import (
	"regexp"
	"strings"

	"github.com/useopendesk/opendesk/internal/httpx"
)

// Website contact forms (contracts/api.md "Inbound email"). A form sends From an address
// of the website with the visitor in Reply-To. A mailbox lists the form addresses it
// trusts; mail from one of them that passed sender authentication is from the visitor.

const maxFormSenders = 50

var formDomainRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

// publicMailDomains are providers anyone can sign up to: a domain entry for one of them
// would let any of their users write as any visitor. List the exact address instead.
var publicMailDomains = map[string]bool{
	"gmail.com": true, "googlemail.com": true, "outlook.com": true, "hotmail.com": true, "live.com": true,
	"msn.com": true, "yahoo.com": true, "ymail.com": true, "icloud.com": true, "me.com": true, "mac.com": true,
	"aol.com": true, "proton.me": true, "protonmail.com": true, "pm.me": true, "gmx.com": true, "gmx.net": true,
	"mail.com": true, "yandex.com": true, "yandex.ru": true, "zoho.com": true, "fastmail.com": true,
}

// cleanFormSenders normalizes trusted_form_senders: at most 50 distinct entries, each an
// email address or "@domain", lowercased. A domain entry cannot be a public email
// provider, and no entry can be the mailbox's own address or one of its aliases.
func cleanFormSenders(list []string, own []string) ([]string, error) {
	if len(list) > maxFormSenders {
		return nil, httpx.Validation("A mailbox can trust at most 50 form senders.")
	}
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	for _, e := range list {
		e = strings.ToLower(strings.TrimSpace(e))
		if d, ok := strings.CutPrefix(e, "@"); ok {
			if !formDomainRe.MatchString(d) || len(d) > 253 {
				return nil, httpx.Validation("Enter form senders as an email address or @domain.")
			}
			if publicMailDomains[d] {
				return nil, httpx.Validation("@" + d + " is a public email provider: enter the form's exact address instead.")
			}
		} else if !validAddress(e) {
			return nil, httpx.Validation("Enter form senders as an email address or @domain.")
		}
		if slicesContainsFold(own, e) {
			return nil, httpx.Validation("A form sender cannot be the mailbox's own address or one of its aliases.")
		}
		if seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out, nil
}

// formSenderTrusted reports whether from matches an entry: the exact address, or an
// "@domain" entry for its domain (not its subdomains).
func formSenderTrusted(list []string, from string) bool {
	from = strings.ToLower(strings.TrimSpace(from))
	if from == "" {
		return false
	}
	dom := "@" + emailDomain(from)
	for _, e := range list {
		if e == from || strings.HasPrefix(e, "@") && e == dom {
			return true
		}
	}
	return false
}

// formVisitorOK reports whether a form's Reply-To may stand for the visitor: a valid
// address that is not one of the workspace's own addresses or on the inbound forwarding
// domain.
func (s *service) formVisitorOK(visitor string, own []string) bool {
	return visitor != "" && validAddress(visitor) && !slicesContainsFold(own, visitor) &&
		!strings.EqualFold(emailDomain(visitor), s.inboundDomain())
}

// PublicMailDomain reports a provider anyone can sign up to (gmail.com, outlook.com and the like):
// its users have nothing in common but the provider.
func PublicMailDomain(d string) bool { return publicMailDomains[strings.ToLower(d)] }
