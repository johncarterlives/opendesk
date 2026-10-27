package tickets

import (
	"testing"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
)

func TestComparePhraseLists(t *testing.T) {
	list := "Your parcel has shipped\n\n  NEWSLETTER  \r\ninvoice #"
	cases := []struct {
		op, have string
		want     bool
	}{
		{"any", "Re: your parcel HAS shipped today", true},
		{"any", "Monthly newsletter", true},
		{"any", "Invoice #1042", true},
		{"any", "Where is my refund?", false},
		{"any", "", false},
		{"none", "Where is my refund?", true},
		{"none", "", true},
		{"none", "Monthly newsletter", false},
		{"none", "invoice #9", false},
	}
	for _, c := range cases {
		if got := compare(c.op, c.have, list); got != c.want {
			t.Errorf("compare(%q, %q) = %v, want %v", c.op, c.have, got, c.want)
		}
	}
	// Empty lines are no phrase: an empty list contains nothing.
	if compare("any", "anything", "\n \n") || !compare("none", "anything", "\n \n") {
		t.Error("an empty phrase list matched a phrase")
	}
	// The single-value ops read the whole value, newlines included.
	if compare("contains", "Monthly newsletter", "newsletter\ninvoice") {
		t.Error("contains split its value into phrases")
	}
}

func TestMatchPhraseLists(t *testing.T) {
	f := facts{subject: "Your parcel has shipped", body: "Tracking number inside", fromEmail: "noreply@carrier.example",
		receivedAt: "orders@shop.example", tags: []string{"carrier-mail", "vip"}, channel: "email"}
	cases := []struct {
		c    hd.Condition
		want bool
	}{
		{hd.Condition{Field: "subject", Op: "any", Value: "newsletter\nhas shipped"}, true},
		{hd.Condition{Field: "subject", Op: "none", Value: "newsletter\nhas shipped"}, false},
		{hd.Condition{Field: "body", Op: "any", Value: "refund\ncomplaint"}, false},
		{hd.Condition{Field: "body", Op: "none", Value: "refund\ncomplaint"}, true},
		{hd.Condition{Field: "from_email", Op: "any", Value: "@bank.example\n@CARRIER.example"}, true},
		{hd.Condition{Field: "received_at", Op: "none", Value: "billing@\nlegal@"}, true},
		// A label: any holds when one label contains a phrase, none when no label does.
		{hd.Condition{Field: "tag", Op: "any", Value: "newsletter\ncarrier"}, true},
		{hd.Condition{Field: "tag", Op: "any", Value: "newsletter\nspam"}, false},
		{hd.Condition{Field: "tag", Op: "none", Value: "newsletter\nVIP"}, false},
		{hd.Condition{Field: "tag", Op: "none", Value: "newsletter\nspam"}, true},
		// Existing ops keep their meaning.
		{hd.Condition{Field: "subject", Op: "contains", Value: "PARCEL"}, true},
		{hd.Condition{Field: "tag", Op: "not_contains", Value: "vip"}, false},
	}
	for _, c := range cases {
		if got := match(c.c, f); got != c.want {
			t.Errorf("match(%+v) = %v, want %v", c.c, got, c.want)
		}
	}
	if !match(hd.Condition{Field: "tag", Op: "none", Value: "vip"}, facts{}) {
		t.Error("tag none on a ticket without labels")
	}
}
