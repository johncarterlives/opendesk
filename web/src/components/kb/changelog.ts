// The changelog's rules as the app applies them (contracts/api.md "Changelog"): an entry is a
// draft or published, and a published entry dated in the future is scheduled. Categories are
// free names, at most five, 32 characters each, compared without case.

import { format, isValid, parse } from "date-fns";
import type { ChangelogEntry } from "@/lib/api/types";

export const MAX_CATEGORIES = 5;
export const MAX_CATEGORY_LENGTH = 32;

/** What a reader sees of an entry: a draft, live, or published but waiting for its date. */
export type EntryState = "draft" | "published" | "scheduled";

export function entryState(e: Pick<ChangelogEntry, "status" | "published_at">, now = Date.now()): EntryState {
  if (e.status === "draft") return "draft";
  return e.published_at && Date.parse(e.published_at) > now ? "scheduled" : "published";
}

/** A typed category with its whitespace collapsed; null when nothing is left. */
export function cleanCategory(name: string): string | null {
  const v = name.trim().replace(/\s+/g, " ");
  return v || null;
}

export type CategoryProblem = "empty" | "tooLong" | "duplicate" | "full";

/** Adds a category to a list, or says why it can't be added. */
export function addCategory(list: string[], name: string): { list: string[] } | { problem: CategoryProblem } {
  const v = cleanCategory(name);
  if (!v) return { problem: "empty" };
  if ([...v].length > MAX_CATEGORY_LENGTH) return { problem: "tooLong" };
  if (list.some((c) => c.toLowerCase() === v.toLowerCase())) return { problem: "duplicate" };
  if (list.length >= MAX_CATEGORIES) return { problem: "full" };
  return { list: [...list, v] };
}

/** Whether two category lists hold the same names in the same order. */
export function sameCategories(a: string[], b: string[]) {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

const DAY = "yyyy-MM-dd";
const TIME = "HH:mm";

/** An instant as the reader's local day ("yyyy-MM-dd") and time ("HH:mm"); empty for null. */
export function localParts(iso: string | null): { day: string; time: string } {
  if (!iso) return { day: "", time: "" };
  const d = new Date(iso);
  if (!isValid(d)) return { day: "", time: "" };
  return { day: format(d, DAY), time: format(d, TIME) };
}

/** A local day and time as an ISO instant; null without a valid day. A missing time is the start of the day. */
export function fromLocalParts(day: string, time: string): string | null {
  if (!day) return null;
  const d = parse(`${day} ${time || "00:00"}`, `${DAY} ${TIME}`, new Date());
  return isValid(d) ? d.toISOString() : null;
}
