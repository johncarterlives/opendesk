import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { MailThreadDetail } from "../api/types";
import { setWorkspaceId } from "../api/client";
import { qk } from "../queries";
import { applyCollabEvent } from "./cache";

const detail = (accountId: string) => ({ account: { id: accountId } }) as unknown as MailThreadDetail;

describe("collab.accounts", () => {
  it("refreshes the open conversations of the account that changed, with its addresses", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.mailThread("t1"), detail("a1"));
    qc.setQueryData(qk.mailThread("t2"), detail("a2"));
    qc.setQueryData(qk.mailAccounts, []);
    expect(applyCollabEvent(qc, "collab.accounts", { account_id: "a1" })).toBe(true);
    expect(qc.getQueryState(qk.mailThread("t1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.mailThread("t2"))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.mailAccounts)?.isInvalidated).toBe(true);
  });

  it("refreshes every open conversation when it names no account", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.mailThread("t1"), detail("a1"));
    qc.setQueryData(qk.mailThread("t2"), detail("a2"));
    applyCollabEvent(qc, "collab.accounts", {});
    expect(qc.getQueryState(qk.mailThread("t1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.mailThread("t2"))?.isInvalidated).toBe(true);
  });
});

it("refreshes a shared conversation's reply preference without fetching its private account", async () => {
  vi.useFakeTimers();
  setWorkspaceId("shared-reply-preference");
  const qc = new QueryClient();
  try {
    qc.setQueryData(qk.mailAccounts, []);
    qc.setQueryData(qk.mailThread("shared"), { account: { id: "private", reply_all: false } });
    qc.setQueryData(qk.mailThread("other"), { account: { id: "other", reply_all: false } });
    expect(applyCollabEvent(qc, "collab.changed", { account_id: "private", thread_ids: ["shared"], folders: false })).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(qc.getQueryState(qk.mailThread("shared"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.mailThread("other"))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(qk.mailAccounts)?.isInvalidated).toBe(false);
    expect(qc.getQueryData(qk.mailAccounts)).toEqual([]);
  } finally {
    qc.clear();
    setWorkspaceId(null);
    vi.useRealTimers();
  }
});
