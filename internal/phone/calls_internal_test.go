package phone

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/useopendesk/opendesk/internal/phone/provider"
	"github.com/useopendesk/opendesk/internal/phone/provider/aircall"
)

func TestNormalizeNumber(t *testing.T) {
	for in, want := range map[string]string{
		"+32 470 12 34 56":    "+32470123456",
		"0032 470/12.34.56":   "+32470123456",
		"+33 (0)6 12-34-56":   "+336123456",
		"+32 (0)470 12 34 56": "+32470123456",
		"0470 12 34 56":       "0470123456",
		"anonymous":           "",
		"":                    "",
		"12":                  "",
		"+1234567890123456":   "",
		"+32 470 12 34 ext9":  "",
	} {
		if got := NormalizeNumber(in); got != want {
			t.Errorf("NormalizeNumber(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSubject(t *testing.T) {
	if s := Subject("en", "inbound", "Jane Doe", "+32470"); s != "Call from Jane Doe" {
		t.Fatal(s)
	}
	if s := Subject("en", "outbound", "", "+32470"); s != "Call to +32470" {
		t.Fatal(s)
	}
	if s := Subject("en", "inbound", "", ""); s != "Call from a withheld number" {
		t.Fatal(s)
	}
	if s := Subject("fr", "inbound", "Jane Doe", "+32470"); s != "Appel de Jane Doe" {
		t.Fatal(s)
	}
	if s := Subject("fr", "outbound", "", "+32470"); s != "Appel vers +32470" {
		t.Fatal(s)
	}
	if s := Subject("de", "inbound", "", ""); s != "Anruf von einer unterdrückten Nummer" {
		t.Fatal(s)
	}
	if s := Subject("cs", "outbound", "Jana Nováková", "+420777"); s != "Odchozí hovor: Jana Nováková" {
		t.Fatal(s)
	}
	if s := Subject("zh", "inbound", "王芳", "+8613800"); s != "来电：王芳" {
		t.Fatal(s)
	}
	if s := Subject("zh", "inbound", "", ""); s != "隐藏号码来电" {
		t.Fatal(s)
	}
}

// Every language has the call words English has, and a workspace locale picks its base
// language, else English; Chinese words are Simplified, so Traditional tags get English.
func TestCallTexts(t *testing.T) {
	for lang, words := range callTexts {
		for k := range callTexts["en"] {
			if words[k] == "" {
				t.Errorf("%s lacks %q", lang, k)
			}
		}
		if len(words) != len(callTexts["en"]) {
			t.Errorf("%s has %d words, English %d", lang, len(words), len(callTexts["en"]))
		}
	}
	for in, want := range map[string]string{"": "en", "fr": "fr", "fr-BE": "fr", "FR_be": "fr", "de-CH": "de", "cs-CZ": "cs", "nl-BE": "en", "en-GB": "en", "pt-BR": "en",
		"zh": "zh", "zh-CN": "zh", "zh_cn": "zh", "zh-Hans": "zh", "zh-TW": "en", "zh-HK": "en", "zh-Hant": "en", "zh-Hant-TW": "en"} {
		if got := callLanguage(in); got != want {
			t.Errorf("callLanguage(%q) = %q, want %q", in, got, want)
		}
	}
	if s := callText("fr", "status.on_hold"); s != "En pause" {
		t.Error(s)
	}
	if s := callText("fr", "status.some_new"); s != "some new" {
		t.Error(s)
	}
}

func at(sec int64) *time.Time { t := time.Unix(sec, 0).UTC(); return &t }

// The same events in any order leave the call in the same state. Like Aircall's, every
// event carries the call's tags and comments as they were then: empty before the team
// labelled the call, so an early event that arrives late must not wipe them.
func TestMergeIsOrderIndependent(t *testing.T) {
	none, order := []string{}, []string{"Order"}
	noComments := []provider.Comment{}
	note := []provider.Comment{{ID: "c1", Text: "Wants a replacement"}}
	events := []provider.Event{
		{CallID: "1", At: *at(100), Call: &provider.Call{Direction: "inbound", Stage: provider.StageRinging, Number: "+32 470 12 34 56", StartedAt: at(100), LineName: "FR - Support",
			Tags: none, Comments: noComments}},
		{CallID: "1", At: *at(110), Call: &provider.Call{Direction: "inbound", Stage: provider.StageAnswered, AnsweredAt: at(110), Agent: &provider.Person{Name: "Anna Agent"},
			Tags: none, Comments: noComments}},
		{CallID: "1", At: *at(200), Final: true, Call: &provider.Call{Direction: "inbound", Stage: provider.StageEnded, AnsweredAt: at(110), EndedAt: at(190), Duration: 90,
			Recording: true, RecordingURL: "https://short/r", LinksValid: time.Hour, Tags: order, Comments: note}},
		{CallID: "1", At: *at(210), Call: &provider.Call{Direction: "inbound", AssetURL: "https://asset", Tags: order, Comments: note}},
	}
	orders := [][]int{{0, 1, 2, 3}, {3, 2, 1, 0}, {2, 0, 3, 1}, {1, 3, 0, 2}}
	var first phoneCall
	for i, order := range orders {
		c := phoneCall{Direction: "inbound"}
		for _, j := range order {
			merge(&c, events[j])
		}
		if c.Stage != provider.StageEnded || c.Outcome != OutcomeAnswered || c.Number != "+32470123456" || c.Duration != 90 ||
			c.AgentName != "Anna Agent" || c.AssetURL != "https://asset" || c.LineName != "FR - Support" || !c.HasRecording ||
			len(c.Tags) != 1 || len(c.Comments) != 1 {
			t.Fatalf("order %v: %+v", order, c)
		}
		if i == 0 {
			first = c
			continue
		}
		if !c.StartedAt.Equal(*first.StartedAt) || !c.AnsweredAt.Equal(*first.AnsweredAt) || !c.EndedAt.Equal(*first.EndedAt) {
			t.Fatalf("order %v: times differ %+v", order, c)
		}
	}
	// A label removed later empties the list: a newer empty list does replace it.
	c := phoneCall{Direction: "inbound"}
	merge(&c, events[2])
	merge(&c, provider.Event{CallID: "1", At: *at(300), Call: &provider.Call{Direction: "inbound", Tags: none, Comments: note}})
	if len(c.Tags) != 0 || len(c.Comments) != 1 {
		t.Fatalf("untagged: %+v", c)
	}
}

// Aircall's own lifecycle, parsed from the fixtures, settles the same in reverse: the
// early events' empty tags and comments do not replace the ones the end brought.
func TestMergeFixturesInReverse(t *testing.T) {
	raw, err := os.ReadFile("provider/aircall/testdata/answered.json")
	if err != nil {
		t.Fatal(err)
	}
	var bodies []json.RawMessage
	if err := json.Unmarshal(raw, &bodies); err != nil {
		t.Fatal(err)
	}
	var evs []provider.Event
	for _, b := range bodies {
		ev, err := aircall.Adapter{}.Parse(b)
		if err != nil {
			t.Fatal(err)
		}
		// Stored and read back by the worker, as in production.
		stored, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		var back provider.Event
		if err := json.Unmarshal(stored, &back); err != nil {
			t.Fatal(err)
		}
		evs = append(evs, back)
	}
	forward, reverse := phoneCall{Direction: "inbound"}, phoneCall{Direction: "inbound"}
	for i := range evs {
		merge(&forward, evs[i])
		merge(&reverse, evs[len(evs)-1-i])
	}
	for name, c := range map[string]phoneCall{"forward": forward, "reverse": reverse} {
		if c.Outcome != OutcomeAnswered || len(c.Tags) != 1 || c.Tags[0] != "Order" || len(c.Comments) != 1 {
			t.Fatalf("%s: outcome %q tags %v comments %+v", name, c.Outcome, c.Tags, c.Comments)
		}
	}
}

func TestOutcome(t *testing.T) {
	c := phoneCall{Stage: provider.StageAnswered, AnsweredAt: at(1)}
	if outcome(c) != "" {
		t.Fatal("a call still going has no outcome")
	}
	c.Stage = provider.StageEnded
	if outcome(c) != OutcomeAnswered {
		t.Fatal("answered")
	}
	c.AnsweredAt = nil
	if outcome(c) != OutcomeMissed {
		t.Fatal("missed")
	}
	c.HasVoicemail = true
	if outcome(c) != OutcomeVoicemail {
		t.Fatal("voicemail")
	}
}
