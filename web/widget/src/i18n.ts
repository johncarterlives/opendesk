// The widget's strings. English is inline; the other languages are small
// catalogs loaded on demand from the script's own origin (/widget/i18n/<lng>.js,
// emitted by vite.widget.config.ts), so the main bundle stays small. Selection
// order: data-lang or opendesk("locale", ...), the visitor's browser languages,
// the workspace default from /v1/widget/config, then English.

export const en = {
  chatWith: "Chat with {name}",
  support: "Support",
  openChat: "Open chat",
  openChatUnread: "Open chat, {count} new",
  dismiss: "Dismiss",
  closeChat: "Close chat",
  greeting: "Hi there. How can we help?",
  replyTime: "We usually reply within a few hours.",
  unavailable: "Chat is unavailable",
  unavailableHint: "Check your connection and try again later.",
  sendMessage: "Send us a message",
  yourConversations: "Your conversations",
  olderConversations: "See older conversations",
  allConversations: "All your conversations",
  backHome: "Back",
  conversation: "Conversation",
  newConversation: "New conversation",
  typing: "{name} is typing…",
  searchHelp: "Search the help center",
  poweredBy: "Powered by opendesk",
  back: "Back to conversations",
  emptyHint: "Ask us anything. We'll reply here, and by email if you leave one.",
  automated: "Automated",
  notSent: "Not sent.",
  retry: "Retry",
  sending: "Sending…",
  captureHint: "Leave your email so we can reply if you step away.",
  name: "Name",
  email: "Email",
  emailPlaceholder: "you@company.com",
  invalidEmail: "Enter a valid email address.",
  saveFailed: "Couldn't save that. Try again.",
  saving: "Saving…",
  continue: "Continue",
  dropFiles: "Drop files to attach",
  removeFile: "Remove {name}",
  fileTypeRefused: "{name} can't be sent here. Try another file type.",
  fileTooLarge: "{name} is larger than 25 MB.",
  placeholder: "Write a message…",
  placeholderEmail: "Add your email above to start",
  message: "Message",
  attach: "Attach files",
  send: "Send",
  newMessage: "New message from {name}: {text}",
  ai: "AI",
  aiAnswer: "Answer written by AI",
  sources: "Sources",
  talkToPerson: "Talk to a person",
  handoffDone: "We've let the team know. Someone will reply here.",
  handoffFailed: "Couldn't reach the team. Try again.",
  chatWithUs: "Chat with us",
  replyTimeAi: "{name} answers right away, the team within a few hours.",
  suggested: "Suggested",
  botTyping: "{name} is writing…",
  checking: "Checking {tool}…",
  checked: "Checked {tool}",
  toolFailed: "Couldn't check {tool}",
  handedOff: "A person will reply here",
  handedOffHint: "You'll see their reply in this conversation, and by email if you left one.",
  actionPending: "Needs your confirmation",
  confirm: "Confirm",
  cancel: "Cancel",
  actionConfirmed: "Confirmed",
  actionDeclined: "Cancelled",
  actionExpired: "Expired",
  actionFailed: "Didn't go through",
  actionError: "Couldn't send that. Try again.",
  rateUp: "Helpful",
  rateDown: "Not helpful",
  ratedThanks: "Thanks for the feedback",
  jumpLatest: "Jump to latest",
  topicsTitle: "What can we help with?",
  topicsHint: "Pick a topic so your message reaches the right people.",
  placeholderTopic: "Pick a topic to start",
  changeTopic: "Change topic",
  offlineDefault: "We're away right now. Leave a message and we'll reply as soon as we're back.",
  recordVoice: "Record a voice message",
  stopRecording: "Stop recording",
  cancelRecording: "Cancel the recording",
  recording: "Recording",
  deleteRecording: "Delete the recording",
  playVoice: "Play voice message",
  pauseVoice: "Pause",
  micBlocked: "Allow the microphone in your browser to record a voice message.",
  micFailed: "Couldn't record. Check your microphone and try again.",
  voiceFileName: "Voice message",
};

export type Dict = typeof en;
export type Key = keyof Dict;

export const SUPPORTED = ["en", "es", "fr", "de", "pt", "it", "nl", "pl", "cs", "ja", "zh-CN", "ko", "tr", "az", "ar"] as const;
export type Locale = (typeof SUPPORTED)[number];
const RTL = new Set<string>(["ar"]);

/** Map any BCP 47 tag onto a supported locale, or null. Same rules as the app (src/i18n). */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const t = tag.trim().replace("_", "-").toLowerCase();
  const exact = SUPPORTED.find((l) => l.toLowerCase() === t);
  if (exact) return exact;
  const base = t.split("-")[0];
  if (base === "zh") return t.includes("hant") || t.endsWith("-tw") || t.endsWith("-hk") ? null : "zh-CN";
  return SUPPORTED.find((l) => l.toLowerCase() === base) ?? null;
}

export function pickLocale(o: { explicit?: string | null; browser?: readonly string[]; workspace?: string | null }): Locale {
  return matchLocale(o.explicit) ?? (o.browser ?? []).map(matchLocale).find((x): x is Locale => !!x) ?? matchLocale(o.workspace) ?? "en";
}

export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

let lang: Locale = "en";
let dict: Dict = en;

export function current(): Locale {
  return lang;
}
export function isRtl(l: string = lang) {
  return RTL.has(l);
}

/** Translate, replacing {name}-style placeholders. Missing keys fall back to English. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = dict[key] || en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

const cache: Partial<Record<Locale, Dict>> = { en };

declare global {
  interface Window {
    __opendeskI18n?: Record<string, Dict>;
  }
}

/** Fetch a catalog. `base` is the URL the widget script was loaded from. */
export async function loadCatalog(l: Locale, base: string): Promise<Dict> {
  const hit = cache[l];
  if (hit) return hit;
  let d: Dict | undefined;
  if (import.meta.env.DEV) {
    const mods = import.meta.glob<{ default: Dict }>("./locales/*.json");
    d = (await mods[`./locales/${l}.json`]?.())?.default;
  } else {
    // A script tag rather than fetch: sites that embed the widget already allow
    // its origin in script-src, not necessarily in connect-src.
    d = await new Promise<Dict | undefined>((resolve) => {
      const s = document.createElement("script");
      s.src = new URL(`i18n/${l}.js`, base).href;
      s.async = true;
      s.onload = () => resolve(window.__opendeskI18n?.[l]);
      s.onerror = () => resolve(undefined);
      document.head.appendChild(s);
      s.remove();
    });
  }
  if (d) cache[l] = d;
  return d ?? en;
}

/** Switch language. Resolves once the catalog is in (English on failure). */
export async function setLocale(l: Locale, base: string): Promise<void> {
  const d = await loadCatalog(l, base);
  // A catalog that failed to load leaves the current language in place.
  if (d !== en || l === "en") {
    lang = l;
    dict = d;
  }
}

/** Test hook. */
export function __setDictForTests(l: Locale, d: Dict) {
  lang = l;
  dict = d;
}

// Locale-aware formatting.

function rtf() {
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "narrow" });
}

function cap(s: string) {
  return s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return rtf().format(0, "second");
  const m = Math.round(s / 60);
  if (m < 60) return rtf().format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf().format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 7) return rtf().format(-d, "day");
  return new Date(iso).toLocaleDateString(lang, { month: "short", day: "numeric" });
}

export function clock(iso: string): string {
  return new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return cap(rtf().format(0, "day"));
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return cap(rtf().format(-1, "day"));
  return d.toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric" });
}
