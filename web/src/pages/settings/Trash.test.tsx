// Settings › Trash lists deleted tickets with who deleted them, and restores them; admins only.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api/endpoints";
import type { DeletedTicket, Role } from "@/lib/api/types";
import Trash from "./Trash";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let role: Role = "admin";
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<object>()), useRole: () => role }));
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<object>()), useNavigate: () => vi.fn() }));

const row = (over: Partial<DeletedTicket>): DeletedTicket => ({
  id: "t1",
  number: 91642,
  subject: "LampTwist Update: Delivery Time",
  status: "open" as const,
  channel: "chat",
  contact: { id: "c1", name: "Carmen", email: "carmen@example.test" },
  message_count: 47,
  deleted_at: "2026-11-05T09:41:38Z",
  deleted_by: { id: "u1", name: "Johan", email: "johan@example.test" },
  deleted_by_api_key: null,
  merged_into_number: null,
  ...over,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  vi.restoreAllMocks();
});

async function render() {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Trash />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

it("lists deleted tickets with who deleted them, and restores one", async () => {
  role = "admin";
  const get = vi.spyOn(api.tickets, "deleted").mockResolvedValue({
    data: [row({}), row({ id: "t2", number: 6014, deleted_by: null, merged_into_number: 669679 }), row({ id: "t3", number: 7, deleted_by: null, deleted_by_api_key: { id: "k1", name: "Cody" } })],
  });
  const post = vi.spyOn(api.tickets, "restore").mockResolvedValue({ id: "t1", number: 91642 } as Awaited<ReturnType<typeof api.tickets.restore>>);
  const host = await render();
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  const text = host.textContent ?? "";
  expect(text).toContain("#91642");
  expect(text).toContain("by Johan");
  expect(text).toContain("by the API key Cody");
  expect(text).toContain("Merged into #669679");
  const buttons = Array.from(host.querySelectorAll("button")).filter((b) => b.textContent === "Restore");
  expect(buttons).toHaveLength(2); // not the merged one
  await act(async () => buttons[0].click());
  expect(post).toHaveBeenCalledWith("t1");
});

it("is for admins only", async () => {
  role = "agent";
  const get = vi.spyOn(api.tickets, "deleted").mockResolvedValue({ data: [] });
  const host = await render();
  expect(get).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Restore");
});
