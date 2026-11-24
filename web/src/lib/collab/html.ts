// Small HTML helpers for Collab: escaping, and the people a comment mentions.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The user ids of the mentions in editor HTML (`<span data-type="mention" data-id="...">`), unique, in order. */
export function mentionIds(html: string): string[] {
  const out: string[] = [];
  const tag = /<span\b[^>]*>/gi;
  for (const m of html.matchAll(tag)) {
    const t = m[0];
    if (!/data-type="mention"|class="[^"]*\bmention\b/.test(t)) continue;
    const id = /data-id="([^"]+)"/.exec(t)?.[1];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The first line of text in stored HTML, cut to `max` characters: what a reply quotes of its parent. */
export function firstLine(html: string, max = 120): string {
  const broken = html.replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|pre)>/gi, "\n");
  const text = new DOMParser().parseFromString(broken, "text/html").body.textContent ?? "";
  const line = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

/** True when editor HTML has no text and no image. */
export function isBlankHtml(html: string): boolean {
  if (/<img\b/i.test(html)) return false;
  return !html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}
