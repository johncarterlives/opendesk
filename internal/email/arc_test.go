package email

import (
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/domain"
)

// Header samples in the shapes Cloudflare Email Routing, Gmail and Microsoft 365 write,
// folded as they arrive. A customer at example.com (p=reject) writes to an address of the
// business at acme.example that forwards to the support mailbox.

// googleSet is the ARC set Gmail adds when a Google Workspace group or forwarding rule
// passes on a message from jane@example.com that passed DMARC.
const googleSet = "ARC-Seal: i=1; a=rsa-sha256; t=1764000000; cv=none;\r\n" +
	"        d=google.com; s=arc-20240605;\r\n" +
	"        b=VGhpcyBpcyBub3QgYSByZWFsIHNpZ25hdHVyZQ==\r\n" +
	"ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605;\r\n" +
	"        h=to:subject:message-id:date:from:mime-version:dkim-signature;\r\n" +
	"        bh=Ym9keQ==; fh=Zg==; b=c2ln\r\n" +
	"ARC-Authentication-Results: i=1; mx.google.com;\r\n" +
	"       dkim=pass header.i=@example.com header.s=s1 header.b=AbCdEf12;\r\n" +
	"       spf=pass (google.com: domain of jane@example.com designates 192.0.2.10 as permitted sender) smtp.mailfrom=jane@example.com;\r\n" +
	"       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com\r\n"

// microsoftSet is the ARC set Microsoft 365 adds when a mailbox rule forwards the message.
const microsoftSet = "ARC-Seal: i=1; a=rsa-sha256; s=arcselector10001; d=microsoft.com; cv=none;\r\n" +
	" b=TWljcm9zb2Z0IHNlYWw=\r\n" +
	"ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=microsoft.com;\r\n" +
	" s=arcselector10001; h=From:Date:Subject:Message-ID:Content-Type:MIME-Version;\r\n" +
	" bh=Ym9keQ==; b=c2ln\r\n" +
	"ARC-Authentication-Results: i=1; mx.microsoft.com 1; spf=pass\r\n" +
	" smtp.mailfrom=example.com; dmarc=pass action=none header.from=example.com;\r\n" +
	" dkim=pass header.d=example.com; arc=none\r\n"

// cloudflareResults is what Email Routing writes above a forwarded message: its own ARC
// set over the chain it received, then its results. SPF passes for the forwarder, which is
// not aligned with From, and the forwarder's footer broke the DKIM body hash.
func cloudflareResults(arc string) string {
	return "ARC-Seal: i=2; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=pass;\r\n" +
		"\tb=Q2xvdWRmbGFyZSBzZWFs\r\n" +
		"ARC-Message-Signature: i=2; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; c=relaxed/relaxed;\r\n" +
		"\th=From:Subject:Date:Message-ID; bh=Ym9keQ==; b=c2ln\r\n" +
		"ARC-Authentication-Results: i=2; mx.cloudflare.net;\r\n" +
		"\tdkim=fail (\"body hash did not verify\") header.d=example.com header.s=s1 header.b=AbCdEf12;\r\n" +
		"\tdmarc=fail reason=\"SPF not aligned (relaxed), DKIM not aligned (relaxed)\" header.from=example.com policy.dmarc=reject;\r\n" +
		"\tspf=pass (mx.cloudflare.net: domain of support+caf_=desk@acme.example designates 209.85.220.41 as permitted sender) smtp.mailfrom=support+caf_=desk@acme.example;\r\n" +
		"\tarc=" + arc + " smtp.remote-ip=209.85.220.41\r\n" +
		"Authentication-Results: mx.cloudflare.net; dkim=fail header.d=example.com;\r\n" +
		"\tdmarc=fail header.from=example.com policy.dmarc=reject; spf=pass smtp.mailfrom=support+caf_=desk@acme.example;\r\n" +
		"\tarc=" + arc + " (i=1 spf=pass dkim=pass dmarc=pass)\r\n"
}

// googleResults is what Gmail writes on a message it delivers to a connected mailbox
// after another server forwarded it.
func googleResults(arc string) string {
	return "Authentication-Results: mx.google.com;\r\n" +
		"       dkim=fail header.i=@example.com header.s=s1 header.b=AbCdEf12;\r\n" +
		"       arc=" + arc + " (i=1 spf=pass spfdomain=example.com dkim=pass dkdomain=example.com dmarc=pass fromdomain=example.com);\r\n" +
		"       spf=softfail (google.com: domain of transitioning jane@example.com does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=jane@example.com;\r\n" +
		"       dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=example.com\r\n"
}

func TestDMARCForwardedMail(t *testing.T) {
	cf := []string{"mx.cloudflare.net"}
	google := []string{"mx.google.com"}
	microsoft := []string{"", "mx.microsoft.com"}
	from := "From: Jane Doe <jane@example.com>\r\n"
	// An ARC set a sealer of the attacker's own makes, claiming the results of a trusted one.
	evilSet := func(i, cv, d, id, dmarcFrom string) string {
		return "ARC-Seal: i=" + i + "; a=rsa-sha256; s=s1; d=" + d + "; cv=" + cv + "; b=ZXZpbA==\r\n" +
			"ARC-Message-Signature: i=" + i + "; a=rsa-sha256; d=" + d + "; s=s1; h=from; bh=Ym9keQ==; b=c2ln\r\n" +
			"ARC-Authentication-Results: i=" + i + "; " + id + "; spf=pass smtp.mailfrom=" + dmarcFrom + ";\r\n" +
			" dmarc=pass header.from=" + dmarcFrom + "\r\n"
	}
	cases := []struct {
		name    string
		headers string
		trusted []string
		want    authVerdict
	}{
		{"google forward to cloudflare", cloudflareResults("pass") + googleSet + from, cf, authPass},
		{"microsoft forward to gmail", googleResults("pass") + microsoftSet + from, google, authPass},
		{"google forward to gmail", googleResults("pass") + googleSet + from, google, authPass},
		{"arc fail", cloudflareResults("fail") + googleSet + from, cf, authFail},
		{"arc none", cloudflareResults("none") + googleSet + from, cf, authFail},
		{"no arc chain", "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=acme.example;\r\n dmarc=fail header.from=example.com; arc=pass\r\n" + from, cf, authFail},
		{"no arc, plain fail", "Authentication-Results: mx.cloudflare.net; dkim=none; dmarc=fail header.from=example.com\r\n" + from, cf, authFail},
		{"first instance passed another domain", cloudflareResults("pass") + strings.ReplaceAll(googleSet, "header.from=example.com", "header.from=other.example") + from, cf, authFail},
		{"first instance failed", cloudflareResults("pass") + strings.Replace(googleSet, "dmarc=pass (p=REJECT", "dmarc=fail (p=REJECT", 1) + from, cf, authFail},
		{"untrusted sealer claims google's results", cloudflareResults("pass") + evilSet("1", "none", "evil.example", "mx.google.com", "example.com") + from, cf, authFail},
		{"google's seal domain, another authserv-id", cloudflareResults("pass") + evilSet("1", "none", "google.com", "mx.evil.example", "example.com") + from, cf, authFail},
		{"untrusted sealer between", strings.ReplaceAll(cloudflareResults("pass"), "i=2;", "i=3;") +
			evilSet("2", "pass", "evil.example", "mx.evil.example", "evil.example") + googleSet + from, cf, authFail},
		{"two first instances", cloudflareResults("pass") + googleSet + evilSet("1", "none", "google.com", "mx.google.com", "example.com") + from, cf, authFail},
		{"missing instance", strings.ReplaceAll(cloudflareResults("pass"), "i=2;", "i=3;") + googleSet + from, cf, authFail},
		{"two from fields", cloudflareResults("pass") + googleSet + from + "From: x@evil.example\r\n", cf, authFail},
		{"sender wrote the arc pass", "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com; arc=none\r\n" +
			"Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com; arc=pass\r\n" + googleSet + from, cf, authFail},
		{"compauth pass", "Authentication-Results: spf=fail (sender IP is 192.0.2.25)\r\n smtp.mailfrom=example.com; dkim=fail (body hash did not verify)\r\n" +
			" header.d=example.com;dmarc=fail action=none\r\n header.from=example.com;compauth=pass reason=130\r\n" + from, microsoft, authPass},
		{"compauth fail", "Authentication-Results: spf=fail (sender IP is 203.0.113.9)\r\n smtp.mailfrom=example.com; dkim=none (message not signed)\r\n" +
			" header.d=none;dmarc=fail action=quarantine\r\n header.from=example.com;compauth=fail reason=000\r\n" + from, microsoft, authFail},
		{"compauth softpass", "Authentication-Results: spf=none smtp.mailfrom=example.com; dmarc=fail action=none header.from=example.com;compauth=softpass reason=201\r\n" + from, microsoft, authFail},
		{"compauth pass below a trusted fail", "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com\r\n" +
			"Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com; compauth=pass reason=130\r\n" + from, cf, authFail},
		{"compauth pass in an untrusted header", "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com\r\n" +
			"Authentication-Results: spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com;compauth=pass reason=130\r\n" + from, cf, authFail},
		{"dmarc pass needs no arc", "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com\r\n" + from, cf, authPass},
	}
	for _, c := range cases {
		raw := []byte(c.headers + "To: support@acme.example\r\nSubject: Re: my order\r\n\r\nbody\r\n")
		if got := dmarcVerdict(raw, c.trusted); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestTrustedSealer(t *testing.T) {
	route := []string{"mx.example.org", "mx.test"}
	for _, c := range []struct {
		domain, id string
		want       bool
	}{
		{"google.com", "mx.google.com", true},
		{"microsoft.com", "mx.microsoft.com", true},
		{"cloudflare-email.net", "mx.cloudflare.net", true},
		{"google.com", "mx.cloudflare.net", false},
		{"example.org", "mx.example.org", true},
		{"mx.example.org", "mx.example.org", true},
		{"other.example", "mx.example.org", false},
		{"test", "mx.test", false},
		{"example.net", "mx.example.net", false},
		{"", "mx.google.com", false},
	} {
		if got := trustedSealer(c.domain, c.id, route); got != c.want {
			t.Errorf("trustedSealer(%q, %q) = %v, want %v", c.domain, c.id, got, c.want)
		}
	}
}

// A customer's reply forwarded on its way to the support mailbox reopens its Solved
// ticket when its ARC chain shows it passed DMARC before forwarding; the same reply with
// a chain from a sealer nobody trusts stays unverified.
func TestForwardedReplyReopens(t *testing.T) {
	w := newWorld(t)
	m := w.mailbox(InboundForwarding, OutboundSystem, nil)
	from := customer()
	dom := emailDomain(from)
	set := strings.ReplaceAll(strings.ReplaceAll(googleSet, "example.com", dom), "jane@"+dom, from)
	results := "Authentication-Results: mx.in.test; spf=pass smtp.mailfrom=acme.example;\r\n dkim=fail header.d=" + dom +
		"; dmarc=fail header.from=" + dom + "; arc=pass (i=1 spf=pass dkim=pass dmarc=pass)\r\n"
	reply := func(chain, ours string) (bool, domain.Ticket) {
		t.Helper()
		raw := results + chain + "From: " + from + "\r\nTo: " + m.Email + "\r\nSubject: Re: hello\r\nIn-Reply-To: " + ours +
			"\r\nMessage-ID: <fw" + crypto.RandomString(8) + "@" + dom + ">\r\n\r\nIt broke again.\r\n"
		msg := w.messageFor(w.receive(m, raw))
		var failed bool
		if err := w.d.DB.Pool.QueryRow(w.ctx, `SELECT auth_failed FROM messages WHERE id = $1`, msg.ID).Scan(&failed); err != nil {
			t.Fatal(err)
		}
		return failed, w.ticket(msg.TicketID)
	}

	tk, ours := firstTicket(t, w, m, from)
	mustExec(t, w.d, `UPDATE tickets SET status = 'solved', solved_at = now() WHERE id = $1`, tk.ID)
	forged := strings.ReplaceAll(set, "d=google.com", "d=evil.example")
	if failed, got := reply(forged, ours); !failed || got.ID != tk.ID || got.Status != domain.StatusSolved {
		t.Fatalf("untrusted sealer: auth_failed %v status %s", failed, got.Status)
	}
	if failed, got := reply(set, ours); failed || got.ID != tk.ID || got.Status != domain.StatusOpen {
		t.Fatalf("forwarded reply: auth_failed %v status %s", failed, got.Status)
	}
}
