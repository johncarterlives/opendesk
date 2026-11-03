import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Ticket, TicketStatus } from "@/lib/api/types";
import { api } from "@/lib/api/endpoints";
import { useSession } from "@/lib/session";
import { qk } from "@/lib/queries";
import { ticket } from "@/lib/test/fixtures";
import { useUnsent } from "@/components/tickets/detail/outbox";
import InboxPage from "./InboxPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Exercise the real page, infinite query and router. The detail double exposes the
// send/undo callback boundary without mounting the editor or sending customer mail.
vi.mock("@/components/tickets/detail/TicketDetail", () => ({
  default: function Detail({ ticketId, onSent }: { ticketId: string; onSent?: (t: Ticket, status: TicketStatus, heldMs: number) => boolean }) {
    const unsent = useUnsent((s) => s[ticketId]);
    return <div>
      <span>{ticketId}</span>
      <output>{unsent?.html}</output>
      <button onClick={() => onSent?.(ticket({ id: ticketId }), "pending", 30_000)}>Send and mark pending</button>
      <button onClick={() => useUnsent.setState({ [ticketId]: { html: "Restored reply", cc: [], bcc: [], uploads: [] } })}>Undo</button>
    </div>;
  },
}));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: () => ({ data: undefined }) }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("@/lib/session")>(), useRole: () => "agent" }));
vi.mock("@/app/RootLayout", () => ({ useDocumentTitle: () => {} }));
vi.mock("@/components/tickets/ListToolbar", () => ({ ListToolbar: () => null }));
vi.mock("@/components/tickets/BulkBar", () => ({ BulkBar: () => null }));
vi.mock("@/components/tickets/TicketRow", () => ({ TicketRow: () => null, awaitingReply: () => false }));

const a = ticket({ id: "a" });
const b = ticket({ id: "b" });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  useUnsent.setState({}, true);
  useSession.setState({ user: null, workspaceId: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubGlobal("scrollTo", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const session = useSession.getState();
  useSession.setState({ workspaceId: "w1", user: { id: "u1", name: "Maya", email: "maya@example.test", avatar_url: null, avatar_source: null, email_verified: true, totp_enabled: false, time_format: "auto", created_at: "2026-01-01" } });
  let resolvePage: (page: Awaited<ReturnType<typeof api.tickets.list>>) => void = () => { throw new Error("page not requested"); };
  const page = new Promise<Awaited<ReturnType<typeof api.tickets.list>>>((resolve) => { resolvePage = resolve; });
  const list = vi.spyOn(api.tickets, "list").mockImplementation(() => page);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.tickets({ status: ["open"] }), { pages: [{ data: [a], next_cursor: "next" }], pageParams: [null] });
  const rootRoute = createRootRoute({ component: Outlet });
  const inbox = createRoute({ getParentRoute: () => rootRoute, path: "/inbox/$folder/{-$ticketId}", component: InboxPage });
  const other = createRoute({ getParentRoute: () => rootRoute, path: "/other", component: () => <p>Other page</p> });
  const router = createRouter({ routeTree: rootRoute.addChildren([inbox, other]), history: createMemoryHistory({ initialEntries: ["/inbox/open/a"] }), defaultPendingMinMs: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const unmount = async () => { await act(async () => root.unmount()); };
  cleanups.push(async () => { await unmount(); host.remove(); qc.clear(); useSession.setState(session, true); });
  await router.load();
  await act(async () => { root.render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>); });
  const click = async (text: string) => {
    const button = Array.from(host.querySelectorAll("button")).find((el) => el.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => button?.click());
  };
  await click("Send and mark pending");
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next" }));
  expect(router.state.location.pathname).toBe("/inbox/open/a");
  const release = async (data: Ticket[] = [b]) => {
    await act(async () => { resolvePage({ data, next_cursor: null }); await page; });
  };
  return { router, host, click, release, unmount };
}

it("keeps Undo's restored reply visible after a delayed next page arrives", async () => {
  const { router, host, click, release } = await setup();
  await click("Undo");
  expect(host.querySelector("output")?.textContent).toBe("Restored reply");
  await release();
  expect(router.state.location.pathname).toBe("/inbox/open/a");
  expect(host.querySelector("output")?.textContent).toBe("Restored reply");
});

it.each(["/inbox/open/chosen", "/inbox/pending/a", "/inbox/open/a?sort=created_at", "/other"])("respects manual navigation to %s while the next page is pending", async (href) => {
  const { router, release } = await setup();
  await act(async () => { await router.navigate({ href }); });
  await release();
  expect(router.state.location.href).toBe(href);
});

it("cancels on a workspace switch before the delayed page arrives", async () => {
  const { router, release } = await setup();
  await act(async () => useSession.setState({ workspaceId: "w2" }));
  await release();
  expect(router.state.location.pathname).toBe("/inbox/open/a");
});

it("still opens the next ticket when nothing cancels the send", async () => {
  const { router, release } = await setup();
  await release();
  expect(router.state.location.pathname).toBe("/inbox/open/b");
});

it("returns to the list when the final page has no next ticket", async () => {
  const { router, release } = await setup();
  await release([]);
  expect(router.state.location.pathname).toBe("/inbox/open");
});

it("does not navigate after the inbox unmounts", async () => {
  const { router, release, unmount } = await setup();
  await unmount();
  await release();
  expect(router.state.location.pathname).toBe("/inbox/open/a");
});
