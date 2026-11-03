import { Command } from "cmdk";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkItem, openSelectedInNewTab } from "./paletteLink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const selected: string[] = [];

beforeEach(() => {
  // jsdom lays nothing out: cmdk measures its list and scrolls to the selected item.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  selected.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** A palette with a ticket link and an action that is not a link. */
function Palette() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Command ref={ref} loop>
      <Command.Input
        onKeyDown={(e) => {
          openSelectedInNewTab(e, ref.current);
        }}
      />
      <Command.List>
        <LinkItem href="/inbox/open/t1" value="ticket 61005" onSelect={() => selected.push("t1")}>
          #61005 Claim
        </LinkItem>
        <Command.Item value="toggle theme" onSelect={() => selected.push("theme")}>
          Theme
        </Command.Item>
      </Command.List>
    </Command>
  );
}

const render = () => act(async () => root.render(<Palette />));
const link = () => host.querySelector<HTMLAnchorElement>("a")!;
const input = () => host.querySelector<HTMLInputElement>("input")!;

/** Dispatches a click, and says whether the browser would still follow the link (jsdom then is kept from trying). */
async function click(init: MouseEventInit = {}): Promise<boolean> {
  let followed = false;
  const last = (e: Event) => {
    followed = !e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener("click", last);
  await act(async () => {
    link().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
  window.removeEventListener("click", last);
  return followed;
}

async function key(init: KeyboardEventInit) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

describe("a palette link", () => {
  it("is a real link that keeps the listbox's option role and never takes the focus", async () => {
    await render();
    const a = link();
    expect(a.getAttribute("href")).toBe("/inbox/open/t1");
    expect(a.getAttribute("role")).toBe("option");
    expect(a.hasAttribute("cmdk-item")).toBe(true);
    expect(a.tabIndex).toBe(-1);
    expect(a.textContent).toBe("#61005 Claim");
  });

  it("opens in place on a plain click, the browser not following the link", async () => {
    await render();
    expect(await click()).toBe(false);
    expect(selected).toEqual(["t1"]);
  });

  it("leaves a Ctrl/Cmd, Shift or Alt click to the browser, without opening in place", async () => {
    await render();
    expect(await click({ ctrlKey: true })).toBe(true);
    expect(await click({ metaKey: true })).toBe(true);
    expect(await click({ shiftKey: true })).toBe(true);
    expect(await click({ altKey: true })).toBe(true);
    expect(selected).toEqual([]);
    // The next plain click opens it in place again.
    expect(await click()).toBe(false);
    expect(selected).toEqual(["t1"]);
  });

  it("opens in place on Enter", async () => {
    await render();
    await key({ key: "Enter" });
    expect(selected).toEqual(["t1"]);
  });

  it("opens in a new tab on Ctrl/Cmd+Enter, not in place", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render();
    await key({ key: "Enter", ctrlKey: true });
    await key({ key: "Enter", metaKey: true });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(`${location.origin}/inbox/open/t1`, "_blank", "noopener");
    expect(selected).toEqual([]);
  });

  it("runs an item that is not a link as on Enter", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render();
    await key({ key: "ArrowDown" });
    await key({ key: "Enter", ctrlKey: true });
    expect(open).not.toHaveBeenCalled();
    expect(selected).toEqual(["theme"]);
  });
});
