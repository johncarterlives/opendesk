import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PeopleSearch } from "@/lib/directorySort";
import { DirectoryFilters } from "./DirectoryFilters";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  // Radix popovers measure their trigger.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  document.body.innerHTML = "";
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>));
  return host;
}

it("shows the label, the blocked filter, a field filter and the sort a People list is on, and clears them", async () => {
  const onSearch = vi.fn();
  const search: PeopleSearch = { q: "ann", tag: "vip", blocked: "true", sort: "-tickets", fields: "plan:set:" };
  const host = await render(<DirectoryFilters scope="contacts" search={search} onSearch={onSearch} />);
  expect(host.textContent).toContain("Label: vip");
  expect(host.textContent).toContain("Blocked only");
  expect(host.textContent).toContain("Sorted by Most tickets");
  expect(host.textContent).toContain("Has a value");

  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear the label filter"]')!.click());
  expect(onSearch).toHaveBeenLastCalledWith({ ...search, tag: undefined });

  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear the plan filter"]')!.click());
  expect(onSearch).toHaveBeenLastCalledWith({ ...search, fields: undefined });

  // Clearing the filters keeps the search and the order.
  const clearAll = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!;
  await act(async () => clearAll.click());
  expect(onSearch).toHaveBeenLastCalledWith({ q: "ann", sort: "-tickets", tag: undefined, blocked: undefined, company: undefined, fields: undefined });
});

it("shows the company filter for People, including people without a company", async () => {
  const onSearch = vi.fn();
  const host = await render(<DirectoryFilters scope="contacts" search={{ company: "none" }} onSearch={onSearch} />);
  expect(host.textContent).toContain("No company");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear company filter"]')!.click());
  expect(onSearch).toHaveBeenLastCalledWith({ company: undefined });
});

it("offers Companies a label and a sort, and no blocked or company filter, starting on its default order", async () => {
  const host = await render(<DirectoryFilters scope="companies" search={{}} onSearch={() => {}} />);
  expect(host.textContent).toContain("Label");
  expect(host.textContent).toContain("Sorted by Name, A to Z");
  expect(host.textContent).not.toContain("Blocked");
  expect(host.textContent).not.toContain("Company");
  expect(host.textContent).not.toContain("Clear filters");

  const people = await render(<DirectoryFilters scope="contacts" search={{}} onSearch={() => {}} />);
  expect(people.textContent).toContain("Sorted by Newest first");
  expect(people.textContent).toContain("Blocked or not");
  expect(people.textContent).toContain("Company");
});
