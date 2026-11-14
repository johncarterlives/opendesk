package domain

import (
	"context"
	"net/mail"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/net/publicsuffix"

	"github.com/useopendesk/opendesk/internal/db"
)

// ReplyAddress is where replies to an inbound email go when it named a Reply-To other than
// its From: that Reply-To when both addresses belong to one organisation (the same registrable
// domain, so alerts@updates.acme.com may ask for answers at jane@acme.com), else "". A Reply-To
// at another organisation stays on the message for agents to see, and replies go to From.
func ReplyAddress(from, replyTo string) string {
	if replyTo == "" || strings.EqualFold(from, replyTo) {
		return ""
	}
	if len(replyTo) > 254 || strings.ContainsAny(replyTo, " \t\r\n<>\"") {
		return ""
	}
	if a, err := mail.ParseAddress(replyTo); err != nil || !strings.EqualFold(a.Address, replyTo) {
		return ""
	}
	f, r := orgDomain(from), orgDomain(replyTo)
	if f == "" || f != r || !strings.Contains(r, ".") {
		return ""
	}
	return strings.ToLower(replyTo)
}

// orgDomain is the registrable domain of an address (mail.acme.co.uk → acme.co.uk), or "".
func orgDomain(addr string) string {
	i := strings.LastIndexByte(addr, '@')
	if i < 0 {
		return ""
	}
	d := strings.ToLower(strings.Trim(addr[i+1:], "."))
	if d == "" {
		return ""
	}
	if o, err := publicsuffix.EffectiveTLDPlusOne(d); err == nil {
		return o
	}
	return d
}

// ReplyRecipients replaces the customer's address in to with the ReplyAddress of their latest
// email on the ticket, when it has one. Mail that failed sender authentication never moves it.
func ReplyRecipients(ctx context.Context, q db.Querier, wid, ticketID uuid.UUID, contactEmail *string, to []string) ([]string, error) {
	if contactEmail == nil || *contactEmail == "" {
		return to, nil
	}
	var from, replyTo string
	err := q.QueryRow(ctx, `SELECT from_email, reply_to FROM messages
		WHERE workspace_id = $1 AND ticket_id = $2 AND direction = 'inbound' AND kind = 'reply' AND NOT auth_failed
		ORDER BY created_at DESC LIMIT 1`, wid, ticketID).Scan(&from, &replyTo)
	if db.IsNotFound(err) {
		return to, nil
	}
	if err != nil {
		return nil, err
	}
	addr := ReplyAddress(from, replyTo)
	if addr == "" || !strings.EqualFold(from, *contactEmail) {
		return to, nil
	}
	out := make([]string, 0, len(to))
	for _, a := range to {
		if strings.EqualFold(strings.TrimSpace(a), *contactEmail) {
			a = addr
		}
		out = append(out, a)
	}
	return out, nil
}
