import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useInfiniteQuery } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { api, rows } from "../api/endpoints";
import { setWorkspaceId } from "../api/client";
import { qk } from "../queries";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import type { MailThread, Page } from "../api/types";
import { useSelectEvery, useThreadAction } from "./hooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("updates inbox/sidebar together, refreshes overview without realtime, and rolls back a refusal", async () => {
  installMock();
  setWorkspaceId(db.workspaces[0].workspace.id);
  const list = await api.collab.threads.list({ box: "inbox" });
  const thread = list.data.find((t) => t.unread);
  if (!thread) throw new Error("Missing unread fixture");
  const detail = await api.collab.threads.get(thread.id);
  const counts = await api.collab.counts();
  const qc = new QueryClient();
  qc.setQueryData(qk.mailFolders(thread.account_id), rows(await api.collab.accounts.folders(thread.account_id)));
  qc.setQueryData(qk.mailThreadLists, { pages: [list], pageParams: [null] });
  qc.setQueryData(qk.mailThread(thread.id), detail);
  qc.setQueryData(qk.mailCounts, counts);
  qc.setQueryData(qk.overview, { workspaces: [] });
  let run: ReturnType<typeof useThreadAction>["mutateAsync"] | undefined;
  function View() { run = useThreadAction().mutateAsync; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<QueryClientProvider client={qc}><View /></QueryClientProvider>));
  const refused = vi.spyOn(api.collab.threads, "action").mockRejectedValueOnce(new Error("Refused"));
  try {
    await act(async () => { await expect(run?.({ ids: [thread.id], action: "read" })).rejects.toThrow("Refused"); });
    expect(qc.getQueryData(qk.mailThread(thread.id))).toEqual(detail);
    expect(qc.getQueryData(qk.mailCounts)).toEqual(counts);
    expect(qc.getQueryState(qk.overview)?.isInvalidated).toBe(true);
    refused.mockRestore();
    await act(async () => { await run?.({ ids: [thread.id], action: "read" }); });
    expect(qc.getQueryData<typeof detail>(qk.mailThread(thread.id))?.thread).toMatchObject({ unread: false, needs_action: thread.needs_action });
    expect(qc.getQueryData<typeof counts>(qk.mailCounts)?.boxes.inbox).toBe(counts.boxes.inbox - 1);
    expect(qc.getQueryData<typeof counts>(qk.mailCounts)?.accounts[thread.account_id]).toBe(counts.accounts[thread.account_id] - 1);
    expect(qc.getQueryData<{ pages: typeof list[] }>(qk.mailThreadLists)?.pages[0].data.find((t) => t.id === thread.id)?.unread).toBe(false);
  } finally {
    refused.mockRestore();
    await act(async () => root.unmount());
    qc.clear();
    setWorkspaceId(null);
  }
});

it("sends a long selection a hundred conversations at a time", async () => {
  installMock();
  setWorkspaceId(db.workspaces[0].workspace.id);
  const qc = new QueryClient();
  let run: ReturnType<typeof useThreadAction>["mutateAsync"] | undefined;
  function View() { run = useThreadAction().mutateAsync; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<QueryClientProvider client={qc}><View /></QueryClientProvider>));
  const sent: number[] = [];
  const spy = vi.spyOn(api.collab.threads, "action").mockImplementation(async (b) => { sent.push(b.thread_ids.length); return { threads: [] }; });
  try {
    await act(async () => { await run?.({ ids: Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`), action: "spam" }); });
    expect(sent).toEqual([100, 100, 50]);
  } finally {
    spy.mockRestore();
    await act(async () => root.unmount());
  }
});

/** A list keyed k of three pages of 50; the first comes at once, each later one when the test lets it. */
async function selectEveryHarness() {
  const qc = new QueryClient();
  const waiting: (() => void)[] = [];
  const fetched: string[] = [];
  const select = vi.fn();
  let every: ReturnType<typeof useSelectEvery> | undefined;
  let shown = "";
  const page = (k: string, n: number): Page<MailThread> => ({
    data: Array.from({ length: 50 }, (_, i) => ({ id: `${k}${n}-${i}` }) as MailThread),
    next_cursor: n < 3 ? String(n + 1) : null,
  });
  function View({ k }: { k: string }) {
    const list = useInfiniteQuery({
      queryKey: ["select-every", k],
      queryFn: ({ pageParam }) => {
        if (pageParam === null) return Promise.resolve(page(k, 1));
        fetched.push(`${k}${pageParam}`);
        return new Promise<Page<MailThread>>((resolve) => waiting.push(() => resolve(page(k, Number(pageParam)))));
      },
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.next_cursor,
    });
    every = useSelectEvery(list, k, select);
    if (list.data) shown = k;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const show = async (k: string) => {
    await act(async () => root.render(<QueryClientProvider client={qc}><View k={k} /></QueryClientProvider>));
    // The first page comes at once; wait for the list to show it.
    await vi.waitFor(() => expect(shown).toBe(k));
  };
  await show("a");
  /** Lets the page being fetched arrive. */
  const arrive = () => act(async () => { waiting.shift()?.(); });
  return { every: () => every!, select, fetched, show, arrive, done: () => act(async () => root.unmount()) };
}

it("selects every conversation of the list, its remaining pages loaded first", async () => {
  const h = await selectEveryHarness();
  try {
    let run: Promise<void> | undefined;
    await act(async () => { run = h.every().start(); });
    expect(h.every().running).toBe(true);
    await h.arrive();
    await h.arrive();
    await act(async () => run);
    expect(h.fetched).toEqual(["a2", "a3"]);
    expect([...h.select.mock.calls[0][0]]).toHaveLength(150);
    expect(h.every().running).toBe(false);
  } finally {
    await h.done();
  }
});

it("selects nothing from another list when the list changes while the rest loads", async () => {
  const h = await selectEveryHarness();
  try {
    let run: Promise<void> | undefined;
    await act(async () => { run = h.every().start(); });
    await h.show("b");
    expect(h.every().running).toBe(false);
    await h.arrive();
    await act(async () => run);
    expect(h.fetched).toEqual(["a2"]);
    expect(h.select).not.toHaveBeenCalled();
  } finally {
    await h.done();
  }
});

it("stops loading and selects nothing once stopped", async () => {
  const h = await selectEveryHarness();
  try {
    let run: Promise<void> | undefined;
    await act(async () => { run = h.every().start(); });
    await act(async () => h.every().stop());
    expect(h.every().running).toBe(false);
    await h.arrive();
    await act(async () => run);
    expect(h.fetched).toEqual(["a2"]);
    expect(h.select).not.toHaveBeenCalled();
  } finally {
    await h.done();
  }
});
