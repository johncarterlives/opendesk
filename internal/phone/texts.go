package phone

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/db"
)

// The words opendesk writes itself for a call, which no reader's app translates: the subject
// of the ticket a call opens and the insight card the provider shows. They are in the
// workspace's language (its locale, the default of its customer-facing pages) when the agent
// app speaks it, else in English, the app's fallback.

// callTexts are those words per language; every language has every key (TestCallTexts).
var callTexts = map[string]map[string]string{
	"en": {
		"from":           "Call from ",
		"to":             "Call to ",
		"withheld":       "Call from a withheld number",
		"number":         "Withheld number",
		"ticket":         "Ticket",
		"earlier":        "Earlier",
		"status.open":    "Open",
		"status.pending": "Pending",
		"status.on_hold": "On hold",
		"status.solved":  "Solved",
		"status.closed":  "Closed",
	},
	"fr": {
		"from":           "Appel de ",
		"to":             "Appel vers ",
		"withheld":       "Appel d’un numéro masqué",
		"number":         "Numéro masqué",
		"ticket":         "Ticket",
		"earlier":        "Précédent",
		"status.open":    "Ouvert",
		"status.pending": "En attente",
		"status.on_hold": "En pause",
		"status.solved":  "Résolu",
		"status.closed":  "Fermé",
	},
	"de": {
		"from":           "Anruf von ",
		"to":             "Anruf an ",
		"withheld":       "Anruf von einer unterdrückten Nummer",
		"number":         "Unterdrückte Nummer",
		"ticket":         "Ticket",
		"earlier":        "Früher",
		"status.open":    "Offen",
		"status.pending": "Wartend",
		"status.on_hold": "Angehalten",
		"status.solved":  "Gelöst",
		"status.closed":  "Geschlossen",
	},
	"cs": {
		"from":           "Příchozí hovor: ",
		"to":             "Odchozí hovor: ",
		"withheld":       "Hovor ze skrytého čísla",
		"number":         "Skryté číslo",
		"ticket":         "Tiket",
		"earlier":        "Dřívější tikety",
		"status.open":    "Otevřený",
		"status.pending": "Čekající",
		"status.on_hold": "Pozastavený",
		"status.solved":  "Vyřešený",
		"status.closed":  "Uzavřený",
	},
	// Simplified Chinese, for the agent app's zh-CN; see callLanguage for which tags get it.
	"zh": {
		"from":           "来电：",
		"to":             "去电：",
		"withheld":       "隐藏号码来电",
		"number":         "隐藏号码",
		"ticket":         "工单",
		"earlier":        "以往工单",
		"status.open":    "打开",
		"status.pending": "待处理",
		"status.on_hold": "保留",
		"status.solved":  "已解决",
		"status.closed":  "已关闭",
	},
}

// callLanguage is a callTexts language for a workspace locale (BCP 47): its base language
// when there are words for it, else English. Chinese has Simplified words only, so only a
// Simplified tag (zh, zh-CN, zh-Hans) gets them; Traditional (zh-TW, zh-Hant) gets English.
func callLanguage(locale string) string {
	tag := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(locale), "_", "-"))
	base, _, _ := strings.Cut(tag, "-")
	if base == "zh" {
		if tag == "zh" || tag == "zh-cn" || tag == "zh-hans" {
			return "zh"
		}
		return "en"
	}
	if _, ok := callTexts[base]; ok {
		return base
	}
	return "en"
}

// workspaceCallLanguage is the language of the workspace's call texts.
func workspaceCallLanguage(ctx context.Context, q db.Querier, wid uuid.UUID) (string, error) {
	var locale string
	if err := q.QueryRow(ctx, `SELECT COALESCE(settings ->> 'locale', '') FROM workspaces WHERE id = $1`, wid).Scan(&locale); err != nil {
		return "", err
	}
	return callLanguage(locale), nil
}

// callText is one of the call words in lang; a status ("status.<status>") without words is
// as stored, spaced.
func callText(lang, key string) string {
	if s, ok := callTexts[lang][key]; ok {
		return s
	}
	if s, ok := callTexts["en"][key]; ok {
		return s
	}
	return strings.ReplaceAll(strings.TrimPrefix(key, "status."), "_", " ")
}
