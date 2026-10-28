// The references an http ticket panel's request carries (contracts/integrations.md "The http
// request"): what the panel's pattern finds in the ticket's subject and messages. The server finds
// them with Go's RE2; settings previews a pattern with the browser's own regular expressions,
// which read the usual patterns the same way.

/** The server's default: a # and 3 digits or more, or 1 to 4 capitals, then digits (S00042, SO-2026-0042, INV/2026/00012). */
export const DEFAULT_REFERENCE_PATTERN = String.raw`#\d{3,}\b|\b[A-Z]{1,4}[-/]?(?:\d{2,4}[-/])?\d{3,}\b`;
export const MAX_REFERENCES = 10;
export const MAX_PATTERN_LENGTH = 200;

/** A pattern as the browser reads it, a leading (?i) as the i flag; null when it does not read or matches an empty text. */
export function referenceRegExp(pattern: string): RegExp | null {
  let p = pattern.trim();
  let flags = "g";
  if (p.startsWith("(?i)")) {
    p = p.slice(4);
    flags += "i";
  }
  if (!p || p.length > MAX_PATTERN_LENGTH) return null;
  try {
    const re = new RegExp(p, flags);
    return re.test("") ? null : re;
  } catch {
    return null;
  }
}

/** What a pattern finds in texts, in order, each once: the first group when it has one. At most 10. */
export function findReferences(re: RegExp, ...texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
      const ref = (m.length > 1 ? (m[1] ?? "") : m[0]).trim().slice(0, 64);
      if (!ref || out.includes(ref)) continue;
      out.push(ref);
      if (out.length === MAX_REFERENCES) return out;
    }
  }
  return out;
}
