import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import { expect, it } from "vitest";
import { useHref } from "./links";
import { useSession } from "./session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderLink() {
  const previous = useSession.getState();
  useSession.setState({ workspaceId: "workspace-a" });
  function Page() {
    const href = useHref();
    return <a href={href({
      to: "/inbox/$folder/{-$ticketId}",
      params: { folder: "open", ticketId: "ticket-a" },
      search: { q: "billing & refunds" },
      hash: "message-42",
    })}>Ticket</a>;
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => rootRoute, path: "/inbox/$folder/{-$ticketId}", component: Page });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/inbox/open/ticket-a"] }), defaultPendingMinMs: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
    useSession.setState(previous, true);
  };
  try {
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
  } catch (error) {
    await cleanup();
    throw error;
  }
  const link = () => {
    const anchor = host.querySelector("a");
    expect(anchor).not.toBeNull();
    return new URL(anchor?.href ?? "", window.location.href);
  };
  return { link, cleanup };
}

it("pins new-document links to the workspace shown and follows workspace changes", async () => {
  const { link, cleanup } = await renderLink();
  try {
    expect(link().searchParams.get("ws")).toBe("workspace-a");
    await act(async () => useSession.setState({ workspaceId: "workspace-b" }));
    expect(link().searchParams.get("ws")).toBe("workspace-b");
  } finally {
    await cleanup();
  }
});

it("preserves the destination, encoded search and message hash, also without a workspace", async () => {
  const { link, cleanup } = await renderLink();
  try {
    expect(link().pathname).toBe("/inbox/open/ticket-a");
    expect(link().searchParams.get("q")).toBe("billing & refunds");
    expect(link().hash).toBe("#message-42");
    await act(async () => useSession.setState({ workspaceId: null }));
    expect(link().searchParams.has("ws")).toBe(false);
    expect(link().pathname).toBe("/inbox/open/ticket-a");
    expect(link().searchParams.get("q")).toBe("billing & refunds");
    expect(link().hash).toBe("#message-42");
  } finally {
    await cleanup();
  }
});
