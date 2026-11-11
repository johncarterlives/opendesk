package domain

import "testing"

func TestReplyAddress(t *testing.T) {
	cases := []struct{ from, replyTo, want string }{
		{"billing@corp.test", "jane@corp.test", "jane@corp.test"},
		{"alerts@updates.whitefoxclean.com", "john@whitefoxclean.com", "john@whitefoxclean.com"},
		{"noreply@mail.acme.com", "Help@Support.Acme.com", "help@support.acme.com"},
		{"a@shop.acme.co.uk", "b@acme.co.uk", "b@acme.co.uk"},
		{"a@acme.co.uk", "b@other.co.uk", ""},
		{"a@alice.github.io", "b@bob.github.io", ""},
		{"ceo@customer.com", "payments@attacker.net", ""},
		{"ceo@customer.com", "ceo@customer.com.attacker.net", ""},
		{"ceo@customer.com", "", ""},
		{"ceo@customer.com", "CEO@customer.com", ""},
		{"ceo@customer.com", "bad address@customer.com", ""},
		{"ceo@customer.com", "x@customer.com>", ""},
	}
	for _, c := range cases {
		if got := ReplyAddress(c.from, c.replyTo); got != c.want {
			t.Errorf("ReplyAddress(%q, %q) = %q, want %q", c.from, c.replyTo, got, c.want)
		}
	}
}
