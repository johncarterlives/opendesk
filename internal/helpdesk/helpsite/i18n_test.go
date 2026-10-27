package helpsite

import (
	"regexp"
	"strings"
	"testing"
)

func TestEveryKeyThePagesUseIsInEnglish(t *testing.T) {
	src, err := templateFS.ReadFile("templates/page.html")
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{"help.articles_one": true, "help.articles_other": true, "help.results_one": true, "help.results_other": true}
	for _, m := range regexp.MustCompile(`\.T\.T "([a-z_.]+)"`).FindAllStringSubmatch(string(src), -1) {
		keys[m[1]] = true
	}
	for _, k := range []string{"help.not_found_title", "help.not_found_body", "help.article_not_found_title", "help.article_not_found_body",
		"help.topic_not_found_title", "help.topic_not_found_body", "help.search_placeholder", "help.search", "help.default_title",
		"help.hero_subtitle", "help.updated", "help.no_results_title", "help.no_results_body", "help.search_min",
		"help.changelog", "help.changelog_subtitle", "help.entry_not_found_title", "help.entry_not_found_body"} {
		keys[k] = true
	}
	for k := range keys {
		if catalogs["en"][k] == "" {
			t.Errorf("en/public.json has no %s", k)
		}
	}
}

func TestPlurals(t *testing.T) {
	cases := []struct {
		lang  string
		n     int
		want  string
		label string
	}{
		{"en", 1, "one", "1 article"}, {"en", 0, "other", "0 articles"}, {"en", 2, "other", "2 articles"},
		{"fr", 0, "one", ""}, {"fr", 1, "one", ""}, {"fr", 2, "other", ""},
		{"pt", 0, "one", ""}, {"de", 1, "one", ""},
		{"pl", 1, "one", "1 artykuł"}, {"pl", 3, "few", "3 artykuły"}, {"pl", 5, "many", "5 artykułów"}, {"pl", 12, "many", ""}, {"pl", 22, "few", ""},
		{"ar", 0, "zero", ""}, {"ar", 2, "two", ""}, {"ar", 5, "few", ""}, {"ar", 11, "many", ""}, {"ar", 100, "other", ""},
		{"ja", 1, "other", ""}, {"zh-CN", 5, "other", ""},
	}
	for _, c := range cases {
		if got := pluralCategory(c.lang, c.n); got != c.want {
			t.Errorf("pluralCategory(%s, %d) = %s, want %s", c.lang, c.n, got, c.want)
		}
		if c.label != "" {
			if got := (translator{lang: c.lang}).N("help.articles", c.n); got != c.label {
				t.Errorf("%s %d articles = %q, want %q", c.lang, c.n, got, c.label)
			}
		}
	}
	// Every locale answers every count with words, not a bare key.
	for _, l := range supported {
		for _, n := range []int{0, 1, 2, 3, 5, 11, 22, 101} {
			for _, key := range []string{"help.articles", "help.results"} {
				if got := (translator{lang: l}).N(key, n); got == "" || strings.Contains(got, "{{") {
					t.Errorf("%s %s %d = %q", l, key, n, got)
				}
			}
		}
	}
}

func TestMatchLocale(t *testing.T) {
	for in, want := range map[string]string{"de": "de", "DE-at": "de", "pt-BR": "pt", "zh": "zh-CN", "zh-Hans-CN": "zh-CN", "zh-TW": "",
		"zh-CN": "zh-CN", "xx": "", "": "", "en_GB": "en"} {
		if got := matchLocale(in); got != want {
			t.Errorf("matchLocale(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestToneForMatchesTheWebApp(t *testing.T) {
	// Values from toneFor in web/src/lib/tones.ts.
	for name, want := range map[string]string{"Billing": "indigo", "Acme help": "indigo", "Getting started": "pink",
		"Überweisungen": "violet", "日本語のヘルプ": "pink", "a very long collection name that overflows": "violet"} {
		if got := toneFor(name); got != want {
			t.Errorf("toneFor(%q) = %s, want %s", name, got, want)
		}
	}
}
