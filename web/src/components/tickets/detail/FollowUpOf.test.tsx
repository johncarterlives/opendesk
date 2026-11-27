import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/client";
import { ticket } from "@/lib/test/fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FollowUpOf } from "./FollowUpOf";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
});

/** The marker of a follow-up of t0, opened in the Open folder. */
async function render() {
  const followUp = ticket({ id: "t1", number: 9, custom: { previous_ticket_id: "t0" } });
  const rootRoute = createRootRoute();
  const inbox = createRoute({ getParentRoute: () => rootRoute, path: "/inbox/$folder/{-$ticketId}", component: () => <TooltipProvider><FollowUpOf ticket={followUp} /></TooltipProvider> });
  const router = createRouter({ routeTree: rootRoute.addChildren([inbox]), history: createMemoryHistory({ initialEntries: ["/inbox/open/t1"] }) });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const qc = new QueryClient();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await router.load();
  await act(async () => root.render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>));
  for (let i = 0; i < 100 && !host.textContent; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
  return host;
}

it("names and links the earlier ticket, in the list being worked", async () => {
  vi.spyOn(api.tickets, "get").mockResolvedValue(ticket({ id: "t0", number: 4, status: "closed" }));
  const host = await render();
  const a = host.querySelector<HTMLAnchorElement>("a[data-follow-up-of]");
  expect(a?.textContent).toBe("Follow-up of #4");
  expect(a?.getAttribute("href")).toBe("/inbox/open/t0");
});

it("does not name an earlier ticket the reader may not see", async () => {
  vi.spyOn(api.tickets, "get").mockRejectedValue(new ApiError({ type: "about:blank", title: "Not found", status: 404, detail: "ticket not found" } as never));
  const host = await render();
  expect(host.textContent).toBe("Follow-up of an earlier ticket");
  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).not.toContain("#");
});
