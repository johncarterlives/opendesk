// Label filters of ticket lists and views (contracts/api.md TicketFilters), as the server
// applies them, for the client cache and the mock API.

import type { TicketFilters } from "./api/types";

/** A label list filter (tag, tag_not): names, comma separated, lowercased. A label name never contains a comma. */
export function labelList(s: string | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether a ticket's labels pass the tag (any of), tag_not (none of) and untagged filters. */
export function labelsMatch(f: Pick<TicketFilters, "tag" | "tag_not" | "untagged">, tags: { name: string }[]): boolean {
  const names = tags.map((x) => x.name.toLowerCase());
  const anyOf = labelList(f.tag);
  if (anyOf.length && !anyOf.some((n) => names.includes(n))) return false;
  if (labelList(f.tag_not).some((n) => names.includes(n))) return false;
  return !(f.untagged && names.length);
}
