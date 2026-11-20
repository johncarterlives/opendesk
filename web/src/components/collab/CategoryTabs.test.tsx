import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { MailCategory } from "@/lib/api/types";
import type { CategoryTab } from "@/lib/collab/categories";
import { startThreadDrag, takeThreadDrops, THREAD_DRAG, type ThreadDropTarget } from "@/lib/collab/threadDrag";
import { CategoryTabs, type CategoryReorder } from "./CategoryTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (key: string, name: string, color: MailCategory["color"] = "gray"): CategoryTab => ({ key, name, description: "", color, unread: 0 });
const TABS = [tab("primary", "Primary"), tab("codes", "Codes / Logins", "green"), tab("updates", "Updates", "blue")];

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => i18n.changeLanguage("en"));
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  document.body.innerHTML = "";
});

async function render(active = "primary", reorder: CategoryReorder | null = null) {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({ getParentRoute: () => rootRoute, path: "/mail/$box/{-$threadId}", component: () => <CategoryTabs tabs={TABS} active={active} search={{}} settings={null} reorder={reorder} /> });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/mail/inbox"] }), defaultPendingMinMs: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => act(async () => root.unmount()));
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

/** A drag's data, as the browser keeps it between the row it started on and where it is dropped. */
function transfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    setDragImage: () => {},
    effectAllowed: "all",
    dropEffect: "none",
  };
}

/** Drags these conversations from the list, as a row does. */
function dragRows(ids: string[]) {
  const dt = transfer();
  startThreadDrag({ dataTransfer: dt } as unknown as DragEvent, ids, `${ids.length} conversations`);
  return dt;
}

function fire(el: Element, type: "dragover" | "drop" | "dragleave", dt: ReturnType<typeof transfer>) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt });
  act(() => void el.dispatchEvent(e));
  return e;
}

const link = (name: string) => [...document.querySelectorAll("a")].find((a) => a.textContent?.includes(name))!;

function takeDrops(accepts: (ids: string[], to: ThreadDropTarget) => boolean = () => true) {
  const drop = vi.fn();
  cleanups.push(takeThreadDrops(drop, accepts));
  return drop;
}

it("takes conversations dropped on another category's tab, lit while they are over it, and hands them to the page", async () => {
  const drop = takeDrops();
  await render();
  const dt = dragRows(["t1", "t2"]);
  const over = fire(link("Codes / Logins"), "dragover", dt);
  expect(over.defaultPrevented).toBe(true);
  expect(dt.dropEffect).toBe("move");
  expect(link("Codes / Logins").className).toContain("bg-chrome-hover");
  fire(link("Codes / Logins"), "drop", dt);
  expect(drop).toHaveBeenCalledWith(["t1", "t2"], { box: "inbox", category: "codes" });
  expect(link("Codes / Logins").className).not.toContain("bg-chrome-hover");
});

it("refuses a drop where the page says the conversations' accounts lack the category, and says why on the tab", async () => {
  const accepts = vi.fn((_ids: string[], to: ThreadDropTarget) => to.category !== "codes");
  const drop = takeDrops(accepts);
  await render();
  const dt = dragRows(["t1", "t2"]);
  // The pointer shows they cannot drop, and the tab says why.
  fire(link("Codes / Logins"), "dragover", dt);
  expect(dt.dropEffect).toBe("none");
  expect(link("Codes / Logins").className).not.toContain("bg-chrome-hover");
  expect(accepts).toHaveBeenCalledWith(["t1", "t2"], { box: "inbox", category: "codes" });
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Their inboxes have no Codes / Logins category");
  fire(link("Codes / Logins"), "drop", dt);
  expect(drop).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')).toBeNull();
  // Another tab takes them.
  fire(link("Updates"), "dragover", dt);
  expect(dt.dropEffect).toBe("move");
  fire(link("Updates"), "dragleave", dt);
  expect(document.querySelector('[role="status"]')).toBeNull();
});

it("does nothing with conversations dropped on the tab in view, where they already are", async () => {
  const drop = takeDrops();
  await render("codes");
  const dt = dragRows(["t1"]);
  expect(fire(link("Codes / Logins"), "dragover", dt).defaultPrevented).toBe(false);
  fire(link("Codes / Logins"), "drop", dt);
  expect(drop).not.toHaveBeenCalled();
  expect(fire(link("Primary"), "dragover", dt).defaultPrevented).toBe(true);
});

it("ignores a drag that carries no conversations, such as a sidebar row", async () => {
  takeDrops();
  await render();
  const dt = transfer();
  dt.setData("application/x-od-sidebar-row", "{}");
  expect(dt.types).not.toContain(THREAD_DRAG);
  expect(fire(link("Updates"), "dragover", dt).defaultPrevented).toBe(false);
});

// Reordering the tabs by dragging them (useTabDrag.ts) or by keyboard.

/** Lays the tabs out as a browser would: 80px each, 2px apart, in their order in the row. */
function layOut() {
  const at = (el: HTMLElement) => (el.dataset.categoryTab ? [...el.parentElement!.children].filter((c) => (c as HTMLElement).dataset.categoryTab).indexOf(el) : -1);
  const left = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft")!;
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get(this: HTMLElement) { return at(this) < 0 ? 0 : at(this) * 82; } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: HTMLElement) { return at(this) < 0 ? 0 : 80; } });
  cleanups.push(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", left);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
  });
}

function pointer(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, button: 0 });
  Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  act(() => void target.dispatchEvent(e));
}

/** Presses a tab, moves the pointer along the row and lets go. */
function dragTab(name: string, ...xs: number[]) {
  const from = link(name).getBoundingClientRect().left + 40 + [...document.querySelectorAll("[data-category-tab]")].indexOf(link(name).parentElement!) * 82;
  pointer(link(name), "pointerdown", from);
  for (const x of xs) pointer(window, "pointermove", from + x);
  pointer(window, "pointerup", from + xs[xs.length - 1]);
}

const order = () => [...document.querySelectorAll<HTMLElement>("[data-category-tab]")].map((el) => el.dataset.categoryTab);

function keyOn(name: string, key: string, mods: KeyboardEventInit = { ctrlKey: true, shiftKey: true }) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  act(() => void link(name).dispatchEvent(e));
  return e;
}

it("moves a tab along the row by dragging it, and saves the new order with Primary first", async () => {
  layOut();
  const reorder = vi.fn<CategoryReorder>(() => new Promise(() => {}));
  await render("primary", reorder);
  dragTab("Updates", -20, -60, -100);
  expect(reorder).toHaveBeenCalledWith(["primary", "updates", "codes"]);
  // Shown in its new place while the order saves.
  expect(order()).toEqual(["primary", "updates", "codes"]);
});

it("never puts a tab before Primary, and Primary does not drag", async () => {
  layOut();
  const reorder = vi.fn<CategoryReorder>(() => Promise.resolve());
  await render("primary", reorder);
  dragTab("Codes / Logins", -40, -120, -300);
  expect(reorder).not.toHaveBeenCalled();
  dragTab("Primary", 40, 120, 200);
  expect(reorder).not.toHaveBeenCalled();
  expect(order()).toEqual(["primary", "codes", "updates"]);
});

it("keeps a press without a drag a click that opens the tab", async () => {
  layOut();
  const reorder = vi.fn<CategoryReorder>(() => Promise.resolve());
  const router = await render("primary", reorder);
  dragTab("Updates", 2);
  act(() => link("Updates").click());
  await act(async () => {});
  expect(reorder).not.toHaveBeenCalled();
  expect(router.state.location.search).toEqual({ category: "updates" });
});

it("moves the focused tab with mod+Shift and the arrows, as a sidebar row moves, says where it went, and never before Primary", async () => {
  const reorder = vi.fn<CategoryReorder>(() => new Promise(() => {}));
  await render("primary", reorder);
  expect(keyOn("Codes / Logins", "ArrowRight").defaultPrevented).toBe(true);
  expect(reorder).toHaveBeenCalledWith(["primary", "updates", "codes"]);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Codes / Logins moved to place 3 of 3");
  reorder.mockClear();
  keyOn("Updates", "ArrowLeft");
  keyOn("Primary", "ArrowRight");
  keyOn("Codes / Logins", "ArrowRight", { altKey: true, shiftKey: true });
  expect(reorder).not.toHaveBeenCalled();
});

it("takes a conversation dragged onto a tab as a move to its category, never as a reorder, and a tab dragged along the row is no conversation", async () => {
  layOut();
  const drop = takeDrops();
  const reorder = vi.fn<CategoryReorder>(() => Promise.resolve());
  await render("primary", reorder);
  const dt = dragRows(["t1"]);
  fire(link("Updates"), "dragover", dt);
  fire(link("Updates"), "drop", dt);
  expect(drop).toHaveBeenCalledWith(["t1"], { box: "inbox", category: "updates" });
  expect(reorder).not.toHaveBeenCalled();
  expect(order()).toEqual(["primary", "codes", "updates"]);
  drop.mockClear();
  dragTab("Updates", -20, -60, -100);
  expect(reorder).toHaveBeenCalledTimes(1);
  expect(drop).not.toHaveBeenCalled();
});

it("does not move at all without a set the viewer may reorder", async () => {
  layOut();
  takeDrops();
  await render("primary", null);
  dragTab("Updates", -20, -60, -100);
  keyOn("Updates", "ArrowLeft");
  expect(order()).toEqual(["primary", "codes", "updates"]);
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(link("Updates").hasAttribute("aria-describedby")).toBe(false);
});
