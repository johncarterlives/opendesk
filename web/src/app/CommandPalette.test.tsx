import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api/endpoints";
import type { SearchResults } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { ticket } from "@/lib/test/fixtures";
import { CommandPalette } from "./CommandPalette";
import { shell } from "./shellStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The first test loads the whole menu and the app's settings index: slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 800 && !ok(); i++) await act(async () => new Promise((r) => setTimeout(r, 25)));
  expect(ok(), what).toBe(true);
};

const found = { tickets: [ticket({ id: "t1", number: 42, subject: "Two factor codes stopped working" })], contacts: [], articles: [], wiki_pages: [] };

/** The real menu, AI off unless asked, with the search's answer held until the test gives it. */
async function setup({ ai = false } = {}) {
  // jsdom lays nothing out: cmdk measures its list and scrolls to the selected item.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView ??= () => {};
  // Everything but the search waits: AI is off until its settings answer, as it is for a workspace without it.
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  let answer: (r: SearchResults) => void = () => {};
  vi.spyOn(api, "search").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  if (ai) {
    vi.spyOn(api.ai, "config").mockResolvedValue({ enabled: true, provider: "anthropic", models: { default: "m", fast: "m" }, embeddings: true, features: { enabled: true }, costs: {} } as never);
    vi.spyOn(api.ai, "search").mockImplementation(() => new Promise(() => {}));
  }

  const session = useSession.getState();
  useSession.setState({
    workspaceId: "w1",
    memberships: [{ workspace: { id: "w1", name: "Acme" }, role: "owner" }] as never,
    user: { id: "u1", name: "Maya", email: "maya@example.test", avatar_url: null, avatar_source: null, email_verified: true, totp_enabled: false, time_format: "auto", created_at: "2026-01-01" },
  });
  const rootRoute = createRootRoute({ component: () => <><CommandPalette /><Outlet /></> });
  const home = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const inbox = createRoute({ getParentRoute: () => rootRoute, path: "/inbox/$folder/{-$ticketId}", component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([home, inbox]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => shell.palette(false));
    await act(async () => root.unmount());
    host.remove();
    qc.clear();
    useSession.setState(session, true);
  });
  await router.load();
  await act(async () => root.render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>));
  await act(async () => shell.palette(true));

  const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
  const type = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const selected = () => document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent ?? "";
  // The app's own settings hits show while the search is out, and as the reader types on, cmdk highlights one.
  await type("two facto");
  await until("settings hits are shown", () => !!document.body.textContent?.includes("Two-factor authentication"));
  await type("two factor");
  await until("a settings hit is highlighted", () => selected().includes("Two-factor authentication"));
  const key = (k: string) => act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  return { router, input, selected, key, type, answer: (r: SearchResults) => act(async () => answer(r)) };
}

it("highlights the top ticket when tickets arrive after the settings hits, so Enter opens it", async () => {
  const { router, input, selected, answer } = await setup();
  await answer(found);
  await until("the ticket is highlighted", () => selected().includes("Two factor codes stopped working"));
  // See all names the query, so cmdk would score it above the tickets it lists.
  const items = [...document.querySelectorAll("[cmdk-item]")].map((e) => e.textContent ?? "");
  expect(items.findIndex((x) => x.startsWith("See all tickets"))).toBe(items.findIndex((x) => x.includes("Two factor codes stopped working")) + 1);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(router.state.location.pathname).toBe("/inbox/open/t1");
});

it("leaves a highlight the arrow keys moved where it is when tickets arrive", async () => {
  const { input, selected, answer } = await setup();
  const first = selected();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const moved = selected();
  expect(moved).not.toBe(first);
  await answer(found);
  await until("the ticket is shown", () => !!document.body.textContent?.includes("Two factor codes stopped working"));
  expect(selected()).toBe(moved);
});

it("with AI on, highlights the top ticket rather than Ask AI, so Enter opens it; Tab still asks", async () => {
  const { router, selected, key, answer } = await setup({ ai: true });
  await until("Ask AI is offered", () => !!document.body.textContent?.includes("Ask AI: two factor"));
  await answer(found);
  await until("the ticket is highlighted", () => selected().includes("Two factor codes stopped working"));
  // Ask AI comes after the results.
  const items = [...document.querySelectorAll("[cmdk-item]")].map((el) => el.textContent ?? "");
  expect(items.findIndex((x) => x.includes("Ask AI: two factor"))).toBeGreaterThan(items.findIndex((x) => x.includes("Two factor codes stopped working")));
  await key("Enter");
  expect(router.state.location.pathname).toBe("/inbox/open/t1");
});

it("with AI on and nothing found, highlights Ask AI, and Tab switches to it", async () => {
  const { selected, key, type, answer } = await setup({ ai: true });
  await type("zxqv nothing here");
  await answer({ tickets: [], contacts: [], articles: [], wiki_pages: [] });
  await until("Ask AI is highlighted", () => selected().includes("Ask AI: zxqv nothing here"));
  await key("Tab");
  await until("Ask AI mode is on", () => !!document.querySelector('[aria-label="Back to search"]'));
});

it("opens every ticket the search finds in the All list, and marks a follow-up", async () => {
  const { router, answer } = await setup();
  await answer({ ...found, tickets: [ticket({ id: "t1", number: 42, subject: "Two factor codes stopped working", custom: { previous_ticket_id: "t0" } })] });
  await until("See all is offered", () => !!document.body.textContent?.includes("See all tickets for “two factor”"));
  expect(document.querySelector("[data-follow-up]")?.closest("[cmdk-item]")?.textContent).toContain("Two factor codes stopped working");
  const all = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) => el.textContent?.includes("See all tickets"))!;
  expect(all.getAttribute("href")).toMatch(/^\/inbox\/all\?q=two\+factor(&|$)/);
  await act(async () => all.click());
  expect(router.state.location.pathname).toBe("/inbox/all");
  expect(router.state.location.search).toEqual({ q: "two factor" });
});
