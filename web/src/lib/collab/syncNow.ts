// A sync asked for by hand (contracts/collab.md: `POST /v1/collab/accounts/{id}/sync` → 202)
// runs in the background, so the button that asked for it spins until it ends (GH#522).
//
// The end shows as the account's `last_synced_at` moving, or its status turning `error`. A
// healthy account's sync publishes no `collab.accounts` when it ends, so while one runs the
// account list is fetched again every few seconds, for at most a minute.

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api/endpoints";
import type { MailAccount, MailAccountStatus } from "../api/types";
import { qk } from "../queries";

export const SYNC_POLL_MS = 2_000;
export const SYNC_TIMEOUT_MS = 60_000;

type Run = {
  /** `last_synced_at` when the sync was asked for: any change means it ended. */
  before: string | null;
  beforeStatus: MailAccountStatus;
  /** Seen in another status than `error` since: a failing account's retry has started. */
  left: boolean;
  poll: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function end(id: string) {
  const r = runs.get(id);
  if (!r) return;
  clearInterval(r.poll);
  clearTimeout(r.timeout);
  runs.delete(id);
  notify();
}

/** Whether the account's state says the run has ended. */
export function syncEnded(r: Pick<Run, "before" | "beforeStatus" | "left">, a: Pick<MailAccount, "last_synced_at" | "status" | "reconnect">): boolean {
  if (a.reconnect) return true;
  if (a.last_synced_at !== r.before) return true;
  return a.status === "error" && (r.beforeStatus !== "error" || r.left);
}

function start(qc: QueryClient, a: MailAccount) {
  if (runs.has(a.id) || a.reconnect) return;
  runs.set(a.id, {
    before: a.last_synced_at,
    beforeStatus: a.status,
    left: false,
    // Both lists: settings reads the managed one for admins.
    poll: setInterval(() => {
      void qc.invalidateQueries({ queryKey: qk.mailAccounts });
      void qc.invalidateQueries({ queryKey: qk.mailAccountsManage });
    }, SYNC_POLL_MS),
    timeout: setTimeout(() => end(a.id), SYNC_TIMEOUT_MS),
  });
  notify();
}

/** Checks a run against the account as it is now, ending it when the sync has. */
function check(a: MailAccount) {
  const r = runs.get(a.id);
  if (!r) return;
  if (a.status !== "error" && !r.left) r.left = true;
  if (syncEnded(r, a)) end(a.id);
}

/**
 * Sync an account now: `syncing` while the sync asked for runs, so the button can spin.
 * `sync` takes the account to start; it tells the caller once the API has queued it.
 */
export function useSyncNow(account: MailAccount | null | undefined) {
  const qc = useQueryClient();
  const id = account?.id;
  const syncing = useSyncExternalStore(
    subscribe,
    () => !!id && runs.has(id),
    () => false,
  );
  useEffect(() => {
    if (account) check(account);
  }, [account]);
  const sync = useCallback(
    (a: MailAccount, opts: { onQueued?: () => void; onError?: (e: unknown) => void } = {}) => {
      start(qc, a);
      api.collab.accounts.sync(a.id).then(
        () => opts.onQueued?.(),
        (e) => {
          end(a.id);
          opts.onError?.(e);
        },
      );
    },
    [qc],
  );
  return { syncing, sync };
}
