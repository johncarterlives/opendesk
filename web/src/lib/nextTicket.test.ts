import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { View } from "./api/types";
import { ticket } from "./test/fixtures";
import { leavesList, nextInList } from "./nextTicket";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "od-next-ticket";

/** The module reads storage once on load, so each case loads a fresh copy. */
async function load() {
  vi.resetModules();
  return import("./nextTicket");
}

describe("next ticket after send preference", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("is on until switched off", async () => {
    expect((await load()).nextTicketAfterSend()).toBe(true);
  });

  it("is kept in this browser and read back on the next load", async () => {
    (await load()).setNextTicketAfterSend(false);
    expect(localStorage.getItem(KEY)).toBe("off");
    expect((await load()).nextTicketAfterSend()).toBe(false);
    (await load()).setNextTicketAfterSend(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect((await load()).nextTicketAfterSend()).toBe(true);
  });

  it("stays on, and still switches for the page, when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const m = await load();
    expect(m.nextTicketAfterSend()).toBe(true);
    m.setNextTicketAfterSend(false);
    expect(m.nextTicketAfterSend()).toBe(false);
  });

  it("re-renders who reads it, here and when another tab changes it", async () => {
    const m = await load();
    const seen: boolean[] = [];
    function Probe() {
      seen.push(m.useNextTicketAfterSend());
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => m.setNextTicketAfterSend(false));
    localStorage.removeItem(KEY);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    expect(seen).toEqual([true, false, true]);
    act(() => root.unmount());
  });
});

describe("leavesList", () => {
  const t = ticket({ status: "open" });

  it("always counts finishing the ticket, even in a list that shows it", () => {
    expect(leavesList({ status: ["open"] }, t, "solved", "u1", [], null)).toBe(true);
    expect(leavesList({ status: ["solved", "closed"] }, t, "closed", "u1", [], null)).toBe(true);
  });

  it("counts another status only where the list's filters no longer match", () => {
    expect(leavesList({ status: ["open"] }, t, "pending", "u1", [], null)).toBe(true);
    expect(leavesList({ status: ["open", "pending", "on_hold"], assignee: "none" }, t, "pending", "u1", [], null)).toBe(false);
    expect(leavesList({}, t, "on_hold", "u1", [], null)).toBe(false);
  });

  it("reads a view's own filters", () => {
    const views = [{ id: "v1", filters: { status: ["open"] } }] as unknown as View[];
    expect(leavesList({ view_id: "v1" }, t, "pending", "u1", views, null)).toBe(true);
    expect(leavesList({ view_id: "v1", status: ["open", "pending"] }, t, "pending", "u1", views, null)).toBe(false);
  });

  it("keeps the ticket where it can't tell: a search, or a view not loaded", () => {
    expect(leavesList({ q: "refund" }, t, "pending", "u1", [], null)).toBe(false);
    expect(leavesList({ view_id: "gone" }, t, "pending", "u1", [], null)).toBe(false);
  });
});

describe("nextInList", () => {
  const a = ticket({ id: "a" });
  const b = ticket({ id: "b" });
  const c = ticket({ id: "c" });

  it("takes the ticket after the current one, as the next button does", () => {
    expect(nextInList([a, b, c], "a")?.id).toBe("b");
    expect(nextInList([a, b, c], "b")?.id).toBe("c");
  });

  it("has none after the last, or for a ticket not in the list", () => {
    expect(nextInList([a, b], "b")).toBeUndefined();
    expect(nextInList([a, b], "x")).toBeUndefined();
  });

  it("goes on with the first ticket of the next page it had not shown", () => {
    // The current one may have left the list by then, and a ticket may have moved up a page.
    expect(nextInList([a, b], "b", [a, c])?.id).toBe("c");
    expect(nextInList([a, b], "b", [a, b])).toBeUndefined();
  });
});
