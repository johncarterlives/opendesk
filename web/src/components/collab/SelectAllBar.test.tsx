import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { SELECT_ALL_MAX } from "@/lib/collab/hooks";
import { SelectAllBar, type SelectAllBarProps } from "./SelectAllBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function show(over: Partial<SelectAllBarProps> = {}) {
  const props: SelectAllBarProps = { loaded: 50, selected: 0, hasMore: true, loading: false, scope: "Spam", onToggle: vi.fn(), onSelectEvery: vi.fn(), ...over };
  await act(async () => root.render(<SelectAllBar {...props} />));
  return props;
}
const box = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;

describe("SelectAllBar", () => {
  it("offers a checkbox before anything is selected, and clicking it selects the loaded conversations", async () => {
    const p = await show();
    expect(box().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Select all");
    await act(async () => box().click());
    expect(p.onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows a partial selection as mixed, with its count and no folder offer", async () => {
    await show({ selected: 3 });
    expect(box().getAttribute("aria-checked")).toBe("mixed");
    expect(container.textContent).toContain("3 selected");
    expect(container.textContent).not.toContain("Select every conversation");
  });

  it("says the selection is the loaded page and offers the whole folder when more exist", async () => {
    const p = await show({ selected: 50 });
    expect(box().getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("All 50 conversations loaded are selected.");
    const every = [...container.querySelectorAll("button")].find((b) => b.textContent === "Select every conversation in Spam")!;
    await act(async () => every.click());
    expect(p.onSelectEvery).toHaveBeenCalledTimes(1);
  });

  it("states the folder is selected once nothing more is left to load", async () => {
    await show({ loaded: 120, selected: 120, hasMore: false });
    expect(container.textContent).toContain("All 120 conversations in Spam are selected.");
    expect(container.textContent).not.toContain("Select every conversation");
  });

  it("is quiet for a short folder that fits one page", async () => {
    await show({ loaded: 8, selected: 8, hasMore: false });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("says when only the first conversations were selected and offers no more", async () => {
    await show({ loaded: SELECT_ALL_MAX, selected: SELECT_ALL_MAX, hasMore: true });
    expect(container.textContent).toContain(`The first ${SELECT_ALL_MAX} conversations in Spam are selected.`);
    expect(container.textContent).not.toContain("Select every conversation");
  });

  it("names a search's results by what they match, never by the box", async () => {
    await show({ selected: 50, matching: true });
    expect(container.textContent).toContain("Select every conversation matching your search");
    expect(container.textContent).not.toContain("Spam");
    await show({ loaded: 37 + 50, selected: 37 + 50, hasMore: false, matching: true });
    expect(container.textContent).toContain("All 87 conversations matching your search are selected.");
    await show({ loaded: SELECT_ALL_MAX, selected: SELECT_ALL_MAX, hasMore: true, matching: true });
    expect(container.textContent).toContain(`The first ${SELECT_ALL_MAX} conversations matching your search are selected.`);
  });

  it("lets the checkbox stop loading the rest, and disables it only when the list is empty", async () => {
    const p = await show({ selected: 50, loading: true });
    expect(box().disabled).toBe(false);
    expect(box().getAttribute("aria-label")).toBe("Clear selection");
    expect(container.textContent).toContain("Selecting every conversation");
    await act(async () => box().click());
    expect(p.onToggle).toHaveBeenCalledTimes(1);
    await show({ loaded: 0, hasMore: false });
    expect(box().disabled).toBe(true);
  });
});
