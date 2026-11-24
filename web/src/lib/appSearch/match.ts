// Word matching for the app's own search (settings, app places, docs): cheap, in the
// browser, in any language. A query's words are matched anywhere in an entry's fields, each
// by the best of: the same word, the same stem, the start of a word (typing), a synonym, one
// or two typos, or a piece of a longer word ("bar" in "sidebar"). Scripts without spaces
// (Chinese, Japanese) match as substrings.

/** A field to search: its words, and how much a match in it counts. */
export interface Field {
  text: string;
  weight: number;
}

export interface Prepared {
  fields: { words: string[]; stems: string[]; norm: string; weight: number }[];
  /** The first field's text, normalized: a query that is all of it, or its start, ranks first. */
  title: string;
}

/** all: every content word must match (a search). most: most of them (a question). */
export type Mode = "all" | "most";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const words = (s: string): string[] => (s ? normalize(s).split(" ").filter(Boolean) : []);

/** A light stem: plural and verb endings off (labels, labeled, labeling → label; archived, archive → archiv). */
export function stem(w: string): string {
  if (w.length < 4 || CJK.test(w)) return w;
  let out = w;
  if (/ies$/.test(out)) out = out.slice(0, -3) + "y";
  else if (/(?:ss|x|z|ch|sh)es$/.test(out)) out = out.slice(0, -2);
  else if (/[^s]s$/.test(out)) out = out.slice(0, -1);
  else if (/ing$/.test(out) && out.length > 5) out = out.slice(0, -3);
  else if (/ed$/.test(out) && out.length > 4) out = out.slice(0, -2);
  if (/[^e]e$/.test(out) && out.length > 3) out = out.slice(0, -1);
  return out;
}

// Words that say what is asked, not what about ("how do I…", "where can I…").
const STOP = new Set(
  "a an and are be can could do does doing find for from get go how i in is it me my of on or our please should the there to want way we what where which who why will with would you your".split(" "),
);
// Words that count when they match, and are never required ("turn on notifications").
const WEAK = new Set("add change edit enable disable make manage new off on remove set setting settings setup turn update use".split(" "));

// Everyday words for what the app calls something else. Each group finds the others.
const SYNONYMS: string[][] = [
  ["sidebar", "navigation", "nav", "menu", "sidebar"],
  ["customize", "customise", "customization", "custom", "arrange", "rearrange", "reorder", "personalize", "personalise", "layout", "organize"],
  ["2fa", "mfa", "totp", "otp", "authenticator", "twofactor", "factor"],
  ["password", "passphrase", "passcode"],
  ["passkey", "webauthn", "fingerprint", "biometric"],
  ["delete", "remove", "erase"],
  ["label", "tag"],
  ["email", "mail", "smtp", "imap"],
  ["mailbox", "inbox", "address"],
  ["signature", "sig"],
  ["notification", "notify", "alert", "bell", "push"],
  ["theme", "dark", "light", "appearance", "color", "colour"],
  ["language", "locale", "translation", "translate"],
  ["timezone", "time", "zone", "clock"],
  ["sla", "deadline", "breach", "target"],
  ["hours", "schedule", "opening", "holiday", "holidays", "office"],
  ["widget", "chat", "messenger", "livechat"],
  ["api", "token", "key", "keys", "developer"],
  ["webhook", "callback", "hook"],
  ["member", "user", "teammate", "people", "staff", "invite", "seat"],
  ["team", "group", "department"],
  ["billing", "plan", "subscription", "invoice", "payment", "pricing", "upgrade", "card"],
  ["ai", "ollie", "assistant", "llm", "gpt", "bot"],
  ["photo", "avatar", "picture", "image", "gravatar"],
  ["logo", "favicon", "branding", "brand"],
  ["import", "migrate", "migration", "zendesk", "freshdesk", "helpscout", "intercom"],
  ["shortcut", "hotkey", "keybinding", "keyboard"],
  ["snooze", "remind", "reminder", "later"],
  ["csat", "satisfaction", "rating", "survey", "feedback"],
  ["automation", "rule", "workflow", "trigger", "macro"],
  ["assignment", "assign", "roundrobin", "distribute", "load"],
  ["routing", "route", "rules"],
  ["spam", "junk", "block"],
  ["trash", "deleted", "bin", "restore", "recycle"],
  ["space", "spaces", "sidebars"],
  ["workspace", "organization", "organisation", "company", "account"],
  ["help", "center", "helpcenter", "kb", "knowledge", "article", "articles", "docs"],
  ["session", "device", "signout", "logout", "logged"],
  ["sound", "audio", "chime", "ding"],
  ["reply", "answer", "respond", "response"],
  ["canned", "saved", "template", "macro", "snippet"],
  ["field", "fields", "property", "properties", "attribute"],
  ["view", "views", "filter", "queue"],
  ["audit", "log", "history", "activity"],
];
const SYN = new Map<string, Set<string>>();
for (const group of SYNONYMS)
  for (const w of group) {
    const s = SYN.get(stem(w)) ?? new Set<string>();
    for (const o of group) if (o !== w) s.add(stem(o));
    SYN.set(stem(w), s);
  }

/** Edit distance with transpositions, giving up past max. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows[i] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0][j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      best = Math.min(best, v);
    }
    if (i > 0 && best > max) return max + 1;
  }
  return rows[a.length][b.length];
}

export function prepare(fields: Field[]): Prepared {
  return {
    fields: fields
      .filter((f) => f.text)
      .map((f) => {
        const w = words(f.text);
        return { words: w, stems: w.map(stem), norm: ` ${w.join(" ")} `, weight: f.weight };
      }),
    title: words(fields[0]?.text ?? "").join(" "),
  };
}

/** How well one query word matches one field, 0 to 1. */
function wordScore(q: string, qs: string, last: boolean, f: Prepared["fields"][number]): number {
  if (CJK.test(q)) return f.norm.includes(q) ? 1 : 0;
  let best = 0;
  const syn = SYN.get(qs);
  const typos = q.length >= 8 ? 2 : q.length >= 5 ? 1 : 0;
  for (let i = 0; i < f.words.length && best < 1; i++) {
    const w = f.words[i];
    const ws = f.stems[i];
    if (w === q) return 1;
    if (ws === qs) best = Math.max(best, 0.95);
    // The word being typed is the start of a word; any word of 3+ letters too.
    else if ((last || q.length >= 3) && w.startsWith(q)) best = Math.max(best, last ? 0.9 : 0.85);
    else if (syn?.has(ws)) best = Math.max(best, 0.75);
    else if (q.length >= 4 && ws.length >= 4 && q.startsWith(ws)) best = Math.max(best, 0.6);
    else if (typos && best < 0.65) {
      const d = distance(q, w, typos);
      if (d <= typos) best = Math.max(best, d === 1 ? 0.65 : 0.5);
      // A typo in a word still being typed: "sidbe" for "sidebar".
      else if (last && w.length > q.length && distance(q, w.slice(0, q.length), 1) <= 1 && q.length >= 4) best = Math.max(best, 0.55);
    }
    if (best < 0.5 && q.length >= 3 && w.length > q.length && w.includes(q)) best = 0.5;
  }
  return best;
}

export interface Query {
  /** Required words. */
  must: { w: string; s: string; last: boolean }[];
  /** Words that help when they match. */
  may: { w: string; s: string; last: boolean }[];
  norm: string;
}

export function parseQuery(text: string): Query {
  const all = words(text);
  const q: Query = { must: [], may: [], norm: all.join(" ") };
  all.forEach((w, i) => {
    const item = { w, s: stem(w), last: i === all.length - 1 && !/\s$/.test(text) };
    if (STOP.has(w) && all.length > 1) return;
    (WEAK.has(w) && all.length > 1 ? q.may : q.must).push(item);
  });
  // "turn on" alone: its weak words are what there is.
  if (!q.must.length) {
    q.must = q.may;
    q.may = [];
  }
  return q;
}

/** The entry's score for the query: 0 when it does not match (or, with `titled`, when no word matches its title). */
export function score(q: Query, e: Prepared, mode: Mode = "all", titled = false): number {
  if (!q.must.length) return 0;
  let total = 0;
  let matched = 0;
  let inTitle = 0;
  let strong = false;
  for (const m of q.must) {
    let best = 0;
    for (const f of e.fields) {
      const s = wordScore(m.w, m.s, m.last, f) * f.weight;
      if (s > best) best = s;
      if (f === e.fields[0] && s >= 0.5 * f.weight) {
        inTitle++;
        if (s >= 0.6 * f.weight) strong = true;
      }
    }
    if (best > 0) matched++;
    else if (mode === "all") return 0;
    total += best;
  }
  if (titled && !strong) return 0;
  if (mode === "most") {
    // A question matches when most of its words do, one of them in the title.
    if (!strong || matched < Math.ceil(q.must.length * 0.6)) return 0;
    total *= matched / q.must.length;
  }
  for (const m of q.may) {
    let best = 0;
    for (const f of e.fields) best = Math.max(best, wordScore(m.w, m.s, m.last, f) * f.weight);
    total += best * 0.3;
  }
  // Of two titles that match alike, the one the query says more of: "Customize sidebar" before "Name in the sidebar".
  const titleWords = e.fields[0]?.words.length ?? 0;
  if (titleWords) total += (0.6 * Math.min(inTitle, titleWords)) / titleWords;
  if (e.title === q.norm) total += 3;
  else if (q.norm.length > 2 && e.title.startsWith(q.norm)) total += 1.5;
  else if (q.norm.length > 3 && e.title.includes(q.norm)) total += 0.8;
  return total;
}

/** The best entries for a query, highest first. */
export function rank<T>(items: readonly T[], prepared: (t: T) => Prepared, query: string, opts: { mode?: Mode; limit?: number; titled?: boolean } = {}): T[] {
  const q = parseQuery(query);
  if (!q.must.length) return [];
  const scored: { t: T; s: number; i: number }[] = [];
  items.forEach((t, i) => {
    const s = score(q, prepared(t), opts.mode, opts.titled);
    if (s > 0) scored.push({ t, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, opts.limit ?? 20).map((x) => x.t);
}
