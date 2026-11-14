package helpsite

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/useopendesk/opendesk/web/src/i18n/locales"
)

// supported are the web app's SUPPORTED locales (web/src/i18n/index.ts), in its order.
var supported = []string{"en", "es", "fr", "de", "pt", "it", "nl", "pl", "cs", "ja", "zh-CN", "ko", "tr", "az", "ar"}

// localeNames are the native names language pickers show.
var localeNames = map[string]string{"en": "English", "es": "Español", "fr": "Français", "de": "Deutsch", "pt": "Português",
	"it": "Italiano", "nl": "Nederlands", "pl": "Polski", "cs": "Čeština", "ja": "日本語", "zh-CN": "简体中文", "ko": "한국어", "tr": "Türkçe", "az": "Azərbaycan dili", "ar": "العربية"}

// catalog is one locale's public.json, flattened to dotted keys.
type catalog map[string]string

var catalogs = func() map[string]catalog {
	out := map[string]catalog{}
	for _, l := range supported {
		raw, err := locales.Public.ReadFile(l + "/public.json")
		if err != nil {
			panic(fmt.Sprintf("helpsite: no %s/public.json: %v", l, err))
		}
		var tree map[string]any
		if err := json.Unmarshal(raw, &tree); err != nil {
			panic(fmt.Sprintf("helpsite: %s/public.json: %v", l, err))
		}
		c := catalog{}
		flatten(c, "", tree)
		out[l] = c
	}
	return out
}()

func flatten(c catalog, prefix string, tree map[string]any) {
	for k, v := range tree {
		switch v := v.(type) {
		case string:
			c[prefix+k] = v
		case map[string]any:
			flatten(c, prefix+k+".", v)
		}
	}
}

// matchLocale maps a BCP 47 tag onto a supported locale, or "" (matchLocale in the web app).
func matchLocale(tag string) string {
	t := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(tag), "_", "-"))
	if t == "" {
		return ""
	}
	for _, l := range supported {
		if strings.ToLower(l) == t {
			return l
		}
	}
	base, _, _ := strings.Cut(t, "-")
	if base == "zh" {
		if strings.Contains(t, "hant") || strings.HasSuffix(t, "-tw") || strings.HasSuffix(t, "-hk") {
			return ""
		}
		return "zh-CN"
	}
	for _, l := range supported {
		if l == base {
			return l
		}
	}
	return ""
}

// translator speaks one locale, falling back to English for a missing key.
type translator struct{ lang string }

// T returns the string for key with {{name}} replaced by args, which come in pairs.
func (tr translator) T(key string, args ...any) string {
	s, ok := catalogs[tr.lang][key]
	if !ok {
		s = catalogs["en"][key]
	}
	return interpolate(s, args...)
}

// N returns the plural form of key for count (i18next's key_one, key_other, ...).
func (tr translator) N(key string, count int) string {
	c := catalogs[tr.lang]
	s, ok := c[key+"_"+pluralCategory(tr.lang, count)]
	if !ok {
		s, ok = c[key+"_other"]
	}
	if !ok {
		s = catalogs["en"][key+"_"+pluralCategory("en", count)]
	}
	return interpolate(s, "count", count)
}

func interpolate(s string, args ...any) string {
	for i := 0; i+1 < len(args); i += 2 {
		name, _ := args[i].(string)
		var v string
		switch x := args[i+1].(type) {
		case string:
			v = x
		case int:
			v = strconv.Itoa(x)
		default:
			v = fmt.Sprint(x)
		}
		s = strings.ReplaceAll(s, "{{"+name+"}}", v)
	}
	return s
}

// pluralCategory is the CLDR plural category of an integer count, as Intl.PluralRules
// gives it to i18next.
func pluralCategory(lang string, n int) string {
	if n < 0 {
		n = -n
	}
	switch lang {
	case "ja", "zh-CN", "ko":
		return "other"
	case "fr", "pt":
		if n == 0 || n == 1 {
			return "one"
		}
		if n%1000000 == 0 {
			return "many"
		}
		return "other"
	case "es", "it":
		if n == 1 {
			return "one"
		}
		if n != 0 && n%1000000 == 0 {
			return "many"
		}
		return "other"
	case "pl":
		switch {
		case n == 1:
			return "one"
		case n%10 >= 2 && n%10 <= 4 && (n%100 < 12 || n%100 > 14):
			return "few"
		}
		return "many"
	case "cs":
		switch {
		case n == 1:
			return "one"
		case n >= 2 && n <= 4:
			return "few"
		}
		return "other"
	case "ar":
		switch {
		case n == 0:
			return "zero"
		case n == 1:
			return "one"
		case n == 2:
			return "two"
		case n%100 >= 3 && n%100 <= 10:
			return "few"
		case n%100 >= 11:
			return "many"
		}
		return "other"
	}
	if n == 1 {
		return "one"
	}
	return "other"
}

// dir is the writing direction of a locale.
func dir(lang string) string {
	if lang == "ar" {
		return "rtl"
	}
	return "ltr"
}
