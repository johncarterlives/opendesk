import { afterEach, describe, expect, it, vi } from "vitest";
import { browserClick, newTabKey, openInNewTab } from "./links";

const click = (o: Partial<Parameters<typeof browserClick>[0]> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...o });
const key = (o: Partial<Parameters<typeof newTabKey>[0]> = {}) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

describe("browserClick", () => {
  it("leaves a plain click to the app", () => {
    expect(browserClick(click())).toBe(false);
  });

  it("leaves a new tab, a new window or a download to the browser", () => {
    expect(browserClick(click({ ctrlKey: true }))).toBe(true);
    expect(browserClick(click({ metaKey: true }))).toBe(true);
    expect(browserClick(click({ shiftKey: true }))).toBe(true);
    expect(browserClick(click({ altKey: true }))).toBe(true);
    expect(browserClick(click({ button: 1 }))).toBe(true);
  });

  it("leaves a click a handler already took", () => {
    expect(browserClick(click({ defaultPrevented: true }))).toBe(true);
  });
});

describe("newTabKey", () => {
  it("is Ctrl+Enter or Cmd+Enter", () => {
    expect(newTabKey(key({ ctrlKey: true }))).toBe(true);
    expect(newTabKey(key({ metaKey: true }))).toBe(true);
  });

  it("is not Enter alone, another key or another chord", () => {
    expect(newTabKey(key())).toBe(false);
    expect(newTabKey(key({ key: "k", ctrlKey: true }))).toBe(false);
    expect(newTabKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(newTabKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe("openInNewTab", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the href in a new tab without a handle on this one", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openInNewTab("/inbox/open/t1");
    expect(open).toHaveBeenCalledWith("/inbox/open/t1", "_blank", "noopener");
  });
});
