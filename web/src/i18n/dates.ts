// Calendar dates in the agent app's language: the date-fns locale for month and
// weekday names, and the short patterns each language writes a date in
// ("Mar 4" in English, "4 mar" in Spanish, "4 mars" in French, "4. März" in German,
// "4. 3." in Czech, which writes a short date in numbers, "10月6日" in Chinese).

import { cs, de, es, fr, zhCN } from "date-fns/locale";
import type { Locale } from "date-fns";
import { AGENT_LOCALES, type AgentLocale, i18n } from "./index";

// monthYear heads a calendar: Czech names the month standing alone (LLLL, "březen",
// not "března" as in a date), Chinese puts the year first.
export type DatePattern = "dayMonth" | "dayMonthYear" | "weekdayDayMonth" | "field" | "monthYear";

const LOCALES: Partial<Record<AgentLocale, Locale>> = { es, fr, de, cs, "zh-CN": zhCN };

const PATTERNS: Record<AgentLocale, Record<DatePattern, string>> = {
  en: { dayMonth: "MMM d", dayMonthYear: "MMM d, yyyy", weekdayDayMonth: "EEE, MMM d", field: "d MMM yyyy", monthYear: "MMMM yyyy" },
  es: { dayMonth: "d MMM", dayMonthYear: "d MMM yyyy", weekdayDayMonth: "EEE, d MMM", field: "d MMM yyyy", monthYear: "MMMM yyyy" },
  fr: { dayMonth: "d MMM", dayMonthYear: "d MMM yyyy", weekdayDayMonth: "EEE d MMM", field: "d MMM yyyy", monthYear: "MMMM yyyy" },
  de: { dayMonth: "d. MMM", dayMonthYear: "d. MMM yyyy", weekdayDayMonth: "EEE, d. MMM", field: "d. MMM yyyy", monthYear: "MMMM yyyy" },
  cs: { dayMonth: "d. M.", dayMonthYear: "d. M. yyyy", weekdayDayMonth: "EEEEEE d. M.", field: "d. M. yyyy", monthYear: "LLLL yyyy" },
  "zh-CN": { dayMonth: "M月d日", dayMonthYear: "yyyy年M月d日", weekdayDayMonth: "EEE M月d日", field: "yyyy年M月d日", monthYear: "yyyy年M月" },
};

/** The agent language for a full tag, a base tag or a locale, or null. */
function agentLocale(lng?: string): AgentLocale | null {
  const tag = (lng ?? i18n.resolvedLanguage ?? i18n.language ?? "en").toLowerCase();
  const exact = AGENT_LOCALES.find((l) => l.toLowerCase() === tag);
  if (exact) return exact;
  const base = tag.split("-")[0];
  if (base === "zh") return tag.includes("hant") || tag.endsWith("-tw") || tag.endsWith("-hk") ? null : "zh-CN";
  return AGENT_LOCALES.find((l) => l.toLowerCase() === base) ?? null;
}

/** The date-fns locale for the language, or undefined for English. */
export function dateLocale(lng?: string): Locale | undefined {
  const l = agentLocale(lng);
  return l ? LOCALES[l] : undefined;
}

/** The date-fns pattern for the language. */
export function datePattern(pattern: DatePattern, lng?: string): string {
  return PATTERNS[agentLocale(lng) ?? "en"][pattern];
}
