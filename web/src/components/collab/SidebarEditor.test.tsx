// The sidebar's edit mode on the mock API: it looks like the sidebar (no panel, no hint, a
// quiet Done and one ⋯ menu on top, an empty Favorites as a one-line drop slot, rows with
// their numbers), and every way of arranging still works: a double-click renames, arrow
// keys on a grip move, the ⋯ holds Layouts and Reset, Escape finishes.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import { sidebarEdit, useSidebarEdit } from "@/lib/collab/sidebarEdit";
import { defaultSidebarPrefs } from "@/lib/collab/sidebarPrefs";
import { useSession } from "@/lib/session";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import { SidebarEditor } from "./SidebarEditor";

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

describe("the sidebar's edit mode", () => {
  installMock();
  const ws = db.workspaces[0];
  let root: Root;
  let el: HTMLDivElement;

  beforeEach(async () => {
    const user = db.users.find((u) => u.id === db.meId);
    useSession.setState({ status: "authed", workspaceId: ws.workspace.id, user, memberships: [{ workspace: ws.workspace, role: "owner" }] } as never);
    // Nothing in Favorites: no pins, no starred pages.
    await api.collab.sidebar.put({ ...defaultSidebarPrefs(), auto_pins: ["box:inbox"], pinned: [] });
    await api.wiki.setFavorites([]);
    el = document.body.appendChild(document.createElement("div"));
    root = createRoot(el);
    act(() => sidebarEdit.start());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <ConfirmProvider>
              <SidebarEditor />
            </ConfirmProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 100 && !el.querySelector('[data-edit-row="ticket_folder:pending"]'); i++) await settle();
  });
  afterEach(() => {
    act(() => root.unmount());
    el.remove();
    act(() => sidebarEdit.stop());
    document.body.innerHTML = "";
  });

  const button = (name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  const rowKeys = (section: string) => [...el.querySelectorAll<HTMLElement>(`[data-edit-section="${section}"] [data-edit-row]`)].map((r) => r.dataset.editRow);

  it("has a quiet top row and no hint, with Layouts and Reset in its ⋯ menu", async () => {
    expect(button("Done")).toBeDefined();
    expect(el.textContent).not.toContain("Drag to move");
    // Layouts and Reset are no longer buttons of their own.
    expect(button("Layouts")).toBeUndefined();
    expect(button("Reset")).toBeUndefined();
    const more = button("More")!;
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map((x) => x.textContent);
    for (let i = 0; i < 100 && !menuItems().includes("Reset"); i++) await settle();
    const items = menuItems();
    expect(items).toEqual(expect.arrayContaining(["Start from a layout", "More options", "Reset"]));
  });

  it("shows an empty Favorites as one drop slot", () => {
    const slots = el.querySelectorAll('[data-edit-section="favorites"] [data-edit-empty]');
    expect(slots).toHaveLength(1);
    expect(slots[0].textContent).toBe("Drop favorites here");
    // Adding favorites is the header's small +, not a bar.
    expect(el.querySelector('[data-edit-section="favorites"] [data-edit-head] button[aria-label="Add rows"]')).not.toBeNull();
  });

  it("draws rows as the sidebar does, with their numbers", async () => {
    // The numbers arrive with the counts query, after the rows.
    const row = () => el.querySelector<HTMLElement>('[data-edit-row="ticket_folder:pending"]')!;
    for (let i = 0; i < 100 && !row().querySelector("[data-count]"); i++) await settle();
    const pending = row();
    expect(pending.textContent).toContain("Pending");
    expect(pending.querySelector("[data-count]")).not.toBeNull();
    expect(pending.querySelector('button[aria-label="Move Pending"]')).not.toBeNull();
  });

  it("renames a row on a double-click", async () => {
    const label = [...el.querySelectorAll<HTMLElement>('[data-edit-row="ticket_folder:pending"] span')].find((s) => s.textContent === "Pending")!;
    await act(async () => {
      label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const field = el.querySelector<HTMLInputElement>('[data-edit-row="ticket_folder:pending"] input')!;
    expect(field.value).toBe("Pending");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(field, "Waiting on them");
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    for (let i = 0; i < 50 && !el.querySelector('[data-edit-row="ticket_folder:pending"]')?.textContent?.includes("Waiting on them"); i++) await settle();
    expect((await api.collab.sidebar.get()).names["ticket_folder:pending"]).toBe("Waiting on them");
  });

  it("moves a row one place with the arrow keys on its grip", async () => {
    const before = rowKeys("inbox");
    const i = before.indexOf("ticket_folder:pending");
    const grip = el.querySelector<HTMLButtonElement>('[data-edit-row="ticket_folder:pending"] button[aria-label="Move Pending"]')!;
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    for (let n = 0; n < 50 && rowKeys("inbox").indexOf("ticket_folder:pending") !== i - 1; n++) await settle();
    expect(rowKeys("inbox").indexOf("ticket_folder:pending")).toBe(i - 1);
  });

  it("finishes on Escape and on Done", async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useSidebarEdit.getState().editing).toBe(false);
    act(() => sidebarEdit.start());
    await act(async () => button("Done")!.click());
    expect(useSidebarEdit.getState().editing).toBe(false);
  });
});
