package email

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/mail"
	"net/netip"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/crypto"
)

// mailKey derives a key from AUTH_SECRET for values we write into outgoing mail and
// verify when they come back.
func (s *service) mailKey(purpose string) []byte {
	var secret []byte
	if s.d != nil && s.d.Cfg != nil {
		secret = s.d.Cfg.AuthSecret
	}
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("opendesk/email/" + purpose))
	return m.Sum(nil)
}

// autoMessageID is the Message-ID of mail we send without storing a message (auto-replies,
// CSAT): "<a_<id>.t<n>@domain>", where id is a random half and a MAC of it, the workspace
// and the ticket number, so a reply naming it can be matched to its ticket.
func (s *service) autoMessageID(wid uuid.UUID, number int64, m *mailboxRow) string {
	var id uuid.UUID
	_, _ = rand.Read(id[:8])
	mac := s.autoMAC(wid, id[:8], number)
	copy(id[8:], mac)
	return messageIDFor("a", id, number, m)
}

func (s *service) autoMAC(wid uuid.UUID, nonce []byte, number int64) []byte {
	m := hmac.New(sha256.New, s.mailKey("auto-message-id"))
	m.Write([]byte(wid.String() + ":" + hex.EncodeToString(nonce) + ":" + itoa(number)))
	return m.Sum(nil)[:8]
}

// verifyAutoID reports whether id (the uuid part of an "a_" Message-ID) was made by
// autoMessageID for this workspace and ticket number.
func (s *service) verifyAutoID(wid uuid.UUID, id string, number int64) bool {
	u, err := uuid.Parse(id)
	if err != nil {
		return false
	}
	return hmac.Equal(u[8:], s.autoMAC(wid, u[:8], number))
}

// loopToken is the X-Loop value of mail a mailbox sends: opaque, so it names the mailbox
// to this instance only.
func (s *service) loopToken(mailboxID uuid.UUID) string {
	return "od-" + crypto.HMACHex(s.mailKey("x-loop"), mailboxID.String())[:32]
}

// ourMessageID splits our own Message-ID format into its kind ('m' for a stored message,
// 'a' for an auto-reply), id and ticket number.
func ourMessageID(ref string) (kind byte, id string, number int64, ok bool) {
	m := ourMsgIDRe.FindStringSubmatch(ref)
	if m == nil || len(ref) < 2 {
		return 0, "", 0, false
	}
	n, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return 0, "", 0, false
	}
	return ref[1], m[1], n, true
}

// Authentication results (RFC 8601).

type authVerdict int

const (
	authUnknown authVerdict = iota
	authPass
	authFail
)

// Routes inbound mail arrives by (inbound_emails.via). Each decides whose sender checks
// (Authentication-Results) are believed for it: only a server the mail passed through
// writes results above what the sender wrote.
const (
	// viaMailbox: read from the mailbox's own provider or IMAP server.
	viaMailbox = ""
	// viaForward: a forwarding address, through the signed inbound endpoint or a relay
	// listed in INBOUND_SMTP_RELAYS.
	viaForward = "forward"
	// viaDirect: the built-in SMTP receiver, straight from the sending server, which
	// writes every header the message carries.
	viaDirect = "direct"
	// viaMember: read from a member's own Collab account, whose provider is neither the
	// mailbox's nor one in INBOUND_AUTHSERV_ID.
	viaMember = "member"
)

// trustedAuthserv lists the authserv-ids whose results are believed for mail that arrived
// at m by via. Mail read from the mailbox believes INBOUND_AUTHSERV_ID and the provider of
// a connected Google or Microsoft mailbox, which is the server that received the mail
// (Microsoft writes its results without an authserv-id, ""). Forwarded mail believes
// INBOUND_AUTHSERV_ID alone: the provider never saw it. Mail straight from a sender's
// server, or read from a member's own account, believes none.
func (s *service) trustedAuthserv(m *mailboxRow, via string) []string {
	if via == viaDirect || via == viaMember {
		return nil
	}
	var out []string
	if s.d != nil && s.d.Cfg != nil {
		for _, v := range s.d.Cfg.InboundAuthservIDs {
			out = append(out, strings.ToLower(strings.TrimSpace(v)))
		}
	}
	if via != viaMailbox {
		return out
	}
	switch m.InboundKind {
	case KindGoogle:
		out = append(out, "mx.google.com")
	case KindMicrosoft:
		out = append(out, "", "mx.microsoft.com")
	}
	return out
}

// relayed reports a connection from a relay listed in INBOUND_SMTP_RELAYS.
func (s *service) relayed(addr net.Addr) bool {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok || s.d == nil || s.d.Cfg == nil {
		return false
	}
	ip, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return false
	}
	ip = ip.Unmap()
	for _, p := range s.d.Cfg.InboundSMTPRelays {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// dmarcVerdict reads the DMARC result from the first Authentication-Results or
// ARC-Authentication-Results header, from the top, whose authserv-id is trusted. A
// receiving server adds its results above everything it received, so headers a sender
// wrote with the same id come after it. Without a trusted header the result is unknown.
//
// A fail in that header still passes when the same header shows the original message
// passed before it was forwarded: Microsoft's composite verdict (compauth=pass), or a
// valid ARC chain (arc=pass) whose every sealer is trusted and whose first instance
// passed DMARC for the same From domain (see forwardedPass).
func dmarcVerdict(raw []byte, trusted []string) authVerdict {
	if len(trusted) == 0 {
		return authUnknown
	}
	fields := headerFields(raw)
	for _, f := range fields {
		var v string
		switch strings.ToLower(f.key) {
		case "authentication-results":
			v = f.value
		case "arc-authentication-results":
			_, rest, ok := arcInstance(f.value)
			if !ok {
				continue
			}
			v = rest
		default:
			continue
		}
		id, clauses := splitAuthResults(v)
		if !slicesContainsExact(trusted, id) {
			continue
		}
		results := readResults(clauses)
		switch results["dmarc"].value {
		case "pass":
			return authPass
		case "fail":
			if results["compauth"].value == "pass" || (results["arc"].value == "pass" && forwardedPass(fields, trusted)) {
				return authPass
			}
			return authFail
		}
		return authUnknown
	}
	return authUnknown
}

// arcSealers are the ARC sealers believed for any route, by the signing domain (d=) of
// their ARC-Seal, each with the authserv-id its ARC-Authentication-Results carry. They
// are the large mailbox providers and forwarding services that seal what they forward.
var arcSealers = map[string]string{
	"google.com":           "mx.google.com",
	"microsoft.com":        "mx.microsoft.com",
	"email.cloudflare.net": "mx.cloudflare.net",
	"cloudflare-email.net": "mx.cloudflare.net",
}

// maxARCInstances is RFC 8617's limit on an ARC chain.
const maxARCInstances = 50

// forwardedPass reports a message whose original passed DMARC before it was forwarded,
// as recorded in its ARC chain (RFC 8617). The trusted receiver's arc=pass vouches that
// every ARC-Seal verified and that the newest ARC-Message-Signature covers the message
// as it arrived. A seal covers only ARC headers, so each sealer vouches for what it saw
// and passed on, nothing more: the chain counts only when every instance, 1 to N, has
// exactly one ARC-Seal and one ARC-Authentication-Results, and every seal is by a trusted
// sealer (arcSealers, or a domain of an authserv-id trusted for the route) writing its
// own authserv-id. A sealer nobody trusts could have changed the message, or replayed a
// trusted sealer's results on another one. Then the first instance must say dmarc=pass
// for the domain in the message's From.
func forwardedPass(fields []headerField, trusted []string) bool {
	from := ""
	type set struct {
		seals, results int
		domain, id     string
		res            map[string]authResult
	}
	sets := map[int]*set{}
	get := func(i int) *set {
		if sets[i] == nil {
			sets[i] = &set{}
		}
		return sets[i]
	}
	froms := 0
	for _, f := range fields {
		switch strings.ToLower(f.key) {
		case "from":
			froms++
			if a, err := mail.ParseAddress(f.value); err == nil {
				from = emailDomain(a.Address)
			}
		case "arc-seal":
			i, rest, ok := arcInstance(f.value)
			if !ok {
				return false
			}
			s := get(i)
			s.seals++
			s.domain = tagValue(rest, "d")
		case "arc-authentication-results":
			i, rest, ok := arcInstance(f.value)
			if !ok {
				return false
			}
			s := get(i)
			s.results++
			id, clauses := splitAuthResults(rest)
			s.id, s.res = id, readResults(clauses)
		}
	}
	if froms != 1 || from == "" || len(sets) == 0 || len(sets) > maxARCInstances {
		return false
	}
	for i := 1; i <= len(sets); i++ {
		s := sets[i]
		if s == nil || s.seals != 1 || s.results != 1 || !trustedSealer(s.domain, s.id, trusted) {
			return false
		}
	}
	first := sets[1].res["dmarc"]
	got := first.props["header.from"]
	if strings.Contains(got, "@") {
		got = emailDomain(got)
	}
	return first.value == "pass" && got == from
}

// trustedSealer reports an ARC sealer believed for the route: one of arcSealers writing
// its own authserv-id, or an authserv-id trusted for the route sealed by that host's
// domain or the domain above it (mx.example.org by example.org).
func trustedSealer(domain, id string, trusted []string) bool {
	if domain == "" || id == "" {
		return false
	}
	if want, ok := arcSealers[domain]; ok && want == id {
		return true
	}
	if !slicesContainsExact(trusted, id) {
		return false
	}
	if domain == id {
		return true
	}
	_, parent, ok := strings.Cut(id, ".")
	return ok && strings.Contains(parent, ".") && domain == parent
}

// arcInstance splits an ARC header's leading "i=<n>;" from the rest.
func arcInstance(v string) (int, string, bool) {
	head, rest, ok := strings.Cut(v, ";")
	if !ok {
		return 0, "", false
	}
	key, num, ok := strings.Cut(strings.TrimSpace(head), "=")
	if !ok || !strings.EqualFold(strings.TrimSpace(key), "i") {
		return 0, "", false
	}
	n, err := strconv.Atoi(strings.TrimSpace(num))
	if err != nil || n < 1 || n > maxARCInstances {
		return 0, "", false
	}
	return n, rest, true
}

// tagValue reads one tag of a DKIM-style tag list ("a=rsa-sha256; d=google.com; ..."),
// lowercased.
func tagValue(list, tag string) string {
	for _, t := range strings.Split(list, ";") {
		k, v, ok := strings.Cut(t, "=")
		if ok && strings.EqualFold(strings.TrimSpace(k), tag) {
			return strings.ToLower(strings.Join(strings.Fields(v), ""))
		}
	}
	return ""
}

func slicesContainsExact(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// splitAuthResults returns the authserv-id ("" when the header starts with a result, as
// Microsoft writes it) and the result clauses.
func splitAuthResults(v string) (string, []string) {
	parts := splitTopLevel(stripComments(v), ';')
	if len(parts) == 0 {
		return "", nil
	}
	first := strings.TrimSpace(parts[0])
	if strings.Contains(first, "=") {
		return "", parts
	}
	// "<authserv-id> [version]"
	if f := strings.Fields(first); len(f) > 0 {
		first = f[0]
	}
	return strings.ToLower(first), parts[1:]
}

// authResult is one result clause: "dmarc=fail action=none header.from=example.com" is
// value "fail" with property header.from "example.com".
type authResult struct {
	value string
	props map[string]string
}

// readResults reads result clauses by method, the first clause of each method counting.
func readResults(clauses []string) map[string]authResult {
	out := map[string]authResult{}
	for _, c := range clauses {
		method, r := parseResult(c)
		if _, seen := out[method]; method != "" && !seen {
			out[method] = r
		}
	}
	return out
}

// parseResult reads "dmarc=fail (p=reject) header.from=x" as ("dmarc", fail, header.from=x).
// Comments are already stripped.
func parseResult(c string) (string, authResult) {
	f := strings.Fields(c)
	if len(f) == 0 {
		return "", authResult{}
	}
	method, value, ok := strings.Cut(f[0], "=")
	if !ok {
		return "", authResult{}
	}
	method = strings.ToLower(strings.TrimSpace(method))
	if i := strings.IndexByte(method, '/'); i >= 0 { // method version, "dmarc/1"
		method = strings.TrimSpace(method[:i])
	}
	r := authResult{value: strings.ToLower(value), props: map[string]string{}}
	if r.value == "" && len(f) > 1 && !strings.Contains(f[1], "=") { // "dmarc= fail"
		r.value, f = strings.ToLower(f[1]), f[1:]
	}
	for _, p := range f[1:] {
		if k, v, ok := strings.Cut(p, "="); ok {
			r.props[strings.ToLower(k)] = strings.ToLower(strings.Trim(v, `"`))
		}
	}
	return method, r
}

// stripComments drops RFC 5322 comments ("(...)", nested) outside quoted strings.
func stripComments(s string) string {
	var b strings.Builder
	depth, quoted := 0, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			if depth == 0 {
				b.WriteByte(c)
				b.WriteByte(s[i+1])
			}
			i++
		case c == '"' && depth == 0:
			quoted = !quoted
			b.WriteByte(c)
		case c == '(' && !quoted:
			depth++
		case c == ')' && !quoted && depth > 0:
			depth--
			b.WriteByte(' ')
		default:
			if depth == 0 {
				b.WriteByte(c)
			}
		}
	}
	return b.String()
}

func splitTopLevel(s string, sep byte) []string {
	var out []string
	quoted, start := false, 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			quoted = !quoted
		case sep:
			if !quoted {
				out = append(out, s[start:i])
				start = i + 1
			}
		}
	}
	if rest := strings.TrimSpace(s[start:]); rest != "" {
		out = append(out, s[start:])
	}
	return out
}

type headerField struct{ key, value string }

// headerFields lists the header fields of a raw message in order, unfolded.
func headerFields(raw []byte) []headerField {
	end := bytes.Index(raw, []byte("\r\n\r\n"))
	if alt := bytes.Index(raw, []byte("\n\n")); end < 0 || (alt >= 0 && alt < end) {
		end = alt
	}
	if end < 0 {
		end = len(raw)
	}
	var out []headerField
	for _, line := range strings.Split(strings.ReplaceAll(string(raw[:end]), "\r\n", "\n"), "\n") {
		if line == "" {
			continue
		}
		if (line[0] == ' ' || line[0] == '\t') && len(out) > 0 {
			out[len(out)-1].value += " " + strings.TrimSpace(line)
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		out = append(out, headerField{key: strings.TrimSpace(k), value: strings.TrimSpace(v)})
		if len(out) >= 1000 {
			break
		}
	}
	return out
}

// contentHash fingerprints what a sender commits to in a message (From, Date, Subject and
// the body), so a message is only ever the same one again when its content matches too.
func contentHash(raw []byte) string {
	h := readHeader(raw)
	body := raw
	if i := bytes.Index(raw, []byte("\r\n\r\n")); i >= 0 {
		body = raw[i+4:]
	} else if i := bytes.Index(raw, []byte("\n\n")); i >= 0 {
		body = raw[i+2:]
	} else {
		body = nil
	}
	sum := sha256.New()
	for _, k := range []string{"From", "Date", "Subject"} {
		sum.Write([]byte(strings.ToLower(strings.Join(strings.Fields(h.Get(k)), " "))))
		sum.Write([]byte{0})
	}
	// Lines without trailing whitespace, without trailing blank lines: line endings and
	// padding a relay may change do not count.
	pending := 0
	for k := 0; len(body) > 0; k++ {
		line := body
		if i := bytes.IndexByte(body, '\n'); i >= 0 {
			line, body = body[:i], body[i+1:]
		} else {
			body = nil
		}
		if k > 0 {
			pending++
		}
		if line = bytes.TrimRight(line, " \t\r"); len(line) == 0 {
			continue
		}
		for ; pending > 0; pending-- {
			sum.Write([]byte{'\n'})
		}
		sum.Write(line)
	}
	return hex.EncodeToString(sum.Sum(nil)[:16])
}

// nullSender reports a message with the null envelope sender of a delivery report: the
// envelope sender when the transport reported it, else the Return-Path the delivering
// server wrote.
func nullSender(envFrom *string, pm *parsedMail) bool {
	if envFrom != nil {
		return strings.Trim(strings.TrimSpace(*envFrom), "<>") == ""
	}
	vals := pm.headerValues("Return-Path")
	return len(vals) > 0 && strings.TrimSpace(vals[0]) == "<>"
}

// automaticMail reports mail that nothing automatic may answer (RFC 3834): automatic,
// bulk or list mail, mail that asks not to be answered automatically, mail carrying
// someone's loop marker, a delivery report, or an out-of-office. A group address that
// redistributes the customer's own support mail is not list mail here.
func automaticMail(pm *parsedMail, mailboxEmail string, null bool) bool {
	if v := strings.ToLower(strings.TrimSpace(pm.header("Auto-Submitted"))); v != "" && v != "no" {
		return true
	}
	own := ownList(pm.header("List-Id"), mailboxEmail)
	switch strings.ToLower(strings.TrimSpace(pm.header("Precedence"))) {
	case "bulk", "junk", "auto_reply":
		return true
	case "list":
		if !own {
			return true
		}
	}
	if !own {
		for _, h := range []string{"List-Id", "List-Unsubscribe", "List-Post"} {
			if strings.TrimSpace(pm.header(h)) != "" {
				return true
			}
		}
	}
	for _, h := range []string{"X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress", loopHeader} {
		if strings.TrimSpace(pm.header(h)) != "" {
			return true
		}
	}
	return null || looksAutomatic(pm)
}

// autoresponse reports mail an autoresponder or a mail loop produced: the markers that
// stop an answer even to a trusted contact form.
func autoresponse(pm *parsedMail, null bool) bool {
	if strings.ToLower(strings.TrimSpace(pm.header("Precedence"))) == "auto_reply" {
		return true
	}
	for _, h := range []string{"X-Autoreply", "X-Autorespond", loopHeader} {
		if strings.TrimSpace(pm.header(h)) != "" {
			return true
		}
	}
	if v := strings.ToLower(strings.TrimSpace(pm.header("Auto-Submitted"))); v == "auto-replied" {
		return true
	}
	return null
}

// keepAutomatic reports whether a mailbox that keeps automatic mail takes in mail the noise
// filter set aside for reason: generated or bulk mail, not an autoresponder's (auto-replied, a
// loop marker, the null sender, or an out-of-office, which Exchange marks auto-generated), a
// bounce or our own mail.
func keepAutomatic(m *mailboxRow, reason string, pm *parsedMail, null bool) bool {
	if !m.KeepAutomaticMail || reason != "auto_submitted" && reason != "precedence" {
		return false
	}
	return !autoresponse(pm, null) && !looksAutomatic(pm)
}

// noReplySender reports an address that never reads a reply.
func noReplySender(addr string) bool {
	local, _, _ := strings.Cut(strings.ToLower(addr), "@")
	local, _, _ = strings.Cut(local, "+")
	for _, n := range noReplyLocals {
		if local == n || strings.HasPrefix(local, n+"-") || strings.HasPrefix(local, n+".") {
			return true
		}
	}
	return strings.Contains(local, "noreply") || strings.Contains(local, "no-reply") || strings.Contains(local, "donotreply")
}
