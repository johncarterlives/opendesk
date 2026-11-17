import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "@/lib/api/types";

const send = vi.fn();
vi.mock("@/lib/api/endpoints", () => ({
  api: { collab: { drafts: { send: (...a: unknown[]) => send(...a) } } },
}));
vi.mock("@/components/ui/toast", () => ({ toast: { held: () => "toast", dismiss: () => {}, info: () => {}, success: () => {}, error: () => {} } }));

const { flushSends, holdSend, releaseSend, undoSend, undoSendSeconds, useHeldSends } = await import("./outbox");
const { setActiveAccount, setWorkspaceId } = await import("@/lib/api/client");
const { useSession } = await import("@/lib/session");

/** What a request sent with no account or workspace pinned carries. */
const plain = { keepalive: false, as: undefined, workspace: undefined };

const sent = { id: "m1", thread_id: "th1", from: { email: "me@x.test" }, sent_at: new Date().toISOString() } as unknown as MailMessage;
const held = (draftId: string, reopen = vi.fn()) => ({ draftId, from: "me@x.test", reopen });

describe("collab outbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    send.mockImplementation(() => Promise.resolve(sent));
    setActiveAccount(null);
    setWorkspaceId(null);
  });
  afterEach(async () => {
    await flushSends();
    vi.useRealTimers();
  });

  it("sends the saved draft once, when its window ends", () => {
    holdSend(held("d1"), 10);
    expect(useHeldSends.getState().d1).toBe(true);
    vi.advanceTimersByTime(9_000);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    // No body: the draft goes out as saved.
    expect(send).toHaveBeenCalledWith("d1", undefined, plain);
    vi.advanceTimersByTime(30_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(useHeldSends.getState().d1).toBeUndefined();
  });

  it("sends nothing after Undo, and opens the draft again", () => {
    const reopen = vi.fn();
    holdSend(held("d2", reopen), 10);
    undoSend("d2");
    vi.advanceTimersByTime(20_000);
    expect(send).not.toHaveBeenCalled();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(useHeldSends.getState().d2).toBeUndefined();
  });

  it("sends once with Send now, not again when the window ends", () => {
    holdSend(held("d3"), 10);
    void releaseSend("d3");
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends at once with no window", () => {
    holdSend(held("d4"), 0);
    expect(send).toHaveBeenCalledWith("d4", undefined, plain);
  });

  it("sends every held draft by its id, with keepalive, when the page closes", async () => {
    holdSend(held("d5"), 30);
    holdSend(held("d6"), 30);
    await flushSends({ keepalive: true });
    expect(send).toHaveBeenCalledWith("d5", undefined, { ...plain, keepalive: true });
    expect(send).toHaveBeenCalledWith("d6", undefined, { ...plain, keepalive: true });
    vi.advanceTimersByTime(30_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends a held draft at once, as the account it was written in, when the account changes", () => {
    setActiveAccount("u1");
    setWorkspaceId("w1");
    useSession.setState({ workspaceId: "w1" });
    holdSend(held("d7"), 30);
    expect(send).not.toHaveBeenCalled();
    setActiveAccount("u2");
    useSession.setState({ workspaceId: "w1" });
    expect(send).toHaveBeenCalledWith("d7", undefined, { keepalive: false, as: "u1", workspace: "w1" });
    expect(useHeldSends.getState().d7).toBeUndefined();
  });

  it("waits the workspace's email undo window, five seconds by default", () => {
    expect(undoSendSeconds(undefined)).toBe(5);
    expect(undoSendSeconds({ undo_send_seconds: 0 })).toBe(0);
    expect(undoSendSeconds({ undo_send_seconds: 20 })).toBe(20);
  });
});
