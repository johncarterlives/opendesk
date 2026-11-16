// The view an account opens on: Inbox, or Unread when that was the last of the two used for
// it (GH#523). Per browser, like the theme. Only these two are remembered: opening Starred,
// Sent, a folder or another box leaves the choice as it was, and Inbox is the default.

import { useSyncExternalStore } from "react";

export type AccountView = "inbox" | "unread";

const KEY = "od-mail-account-views";
const listeners = new Set<() => void>();

/** Accounts that open on Unread; every other account opens on Inbox. */
function read(): ReadonlySet<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let unread = read();

function write(next: ReadonlySet<string>) {
  unread = next;
  try {
    if (next.size) localStorage.setItem(KEY, JSON.stringify([...next]));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  // Another tab changed it.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    unread = read();
    listeners.forEach((l) => l());
  });
}

export function isAccountView(box: string | null | undefined): box is AccountView {
  return box === "inbox" || box === "unread";
}

/** Remembers the view used for an account, when it is one of the two. */
export function rememberAccountView(accountId: string, box: string | null | undefined) {
  if (!isAccountView(box) || (box === "unread") === unread.has(accountId)) return;
  const next = new Set(unread);
  if (box === "unread") next.add(accountId);
  else next.delete(accountId);
  write(next);
}

/**
 * The view an account opens on. While the account is open on one of the two (`here`), that
 * one, so a link drawn before the page has remembered it already points there.
 */
export function accountView(accountId: string, here?: { box: string | null; account?: string; folder?: string }): AccountView {
  if (here && here.account === accountId && !here.folder && isAccountView(here.box)) return here.box;
  return unread.has(accountId) ? "unread" : "inbox";
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const snapshot = () => unread;

/** Re-renders the caller when a remembered view changes (here or in another tab). */
export function useAccountViews(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
