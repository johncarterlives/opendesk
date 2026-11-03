// After a send that finishes a ticket, or sets a status that takes it out of the list it was
// opened from, the next ticket of that list opens (Settings → Profile → Appearance, per
// browser like the theme, on by default): the one the ticket header's next button opens, or
// the list itself after the last one (pages/inbox/InboxPage.tsx).

import { useSyncExternalStore } from "react";
import type { TicketListQuery } from "./api/endpoints";
import type { Ticket, TicketStatus, View } from "./api/types";
import { ticketMatches } from "./ticketCache";

const KEY = "od-next-ticket";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let enabled = read();

export function setNextTicketAfterSend(on: boolean) {
  enabled = on;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function nextTicketAfterSend(): boolean {
  return enabled;
}

if (typeof window !== "undefined") {
  // Another tab changed it.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    enabled = read();
    listeners.forEach((l) => l());
  });
}

// Stable across renders, so a reader subscribes once.
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function snapshot() {
  return enabled;
}

export function useNextTicketAfterSend(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Whether sending with `status` takes the ticket out of the list `query` shows: always when
 * it finishes the ticket, otherwise when the list's filters no longer match it ("can't tell",
 * a search or a company filter, keeps it).
 */
export function leavesList(query: TicketListQuery, t: Ticket, status: TicketStatus, me: string, views: View[] | undefined, myTeams: string[] | null): boolean {
  if (status === "solved" || status === "closed") return true;
  return ticketMatches(query, { ...t, status }, me, views, myTeams) === false;
}

/**
 * The ticket to open after `current` leaves the list: the one after it in `before` (the list
 * as it was when the send went), else the first of `after` (the list once its next page came
 * in) it had not shown yet. None means the list is done.
 */
export function nextInList(before: Ticket[], current: string, after?: Ticket[]): Ticket | undefined {
  const i = before.findIndex((x) => x.id === current);
  if (i < 0) return undefined;
  if (i + 1 < before.length) return before[i + 1];
  if (!after) return undefined;
  const shown = new Set(before.map((x) => x.id));
  return after.find((x) => !shown.has(x.id));
}
