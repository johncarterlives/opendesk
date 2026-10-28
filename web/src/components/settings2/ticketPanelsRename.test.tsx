import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/client";
import type { TicketPanel } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { RenamePanelDialog, TicketPanelsSection } from "./ticketPanels";

const update = vi.fn();
vi.mock("@/lib/api/endpoints", () => ({ api: { ticketPanels: { list: () => new Promise(() => {}), update: (...a: unknown[]) => update(...a) } } }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  update.mockReset();
  vi.mocked(toast.success).mockReset();
});

const panel: TicketPanel = {
  id: "p1",
  kind: "http",
  name: "Odoo",
  host: "erp.example.com",
  fields: [],
  reference_pattern: "",
  enabled: true,
  position: 0,
  status: "connected",
  last_error: "",
  created_at: "2026-10-27T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
};

async function mount(node: ReactNode, panels: TicketPanel[] = [panel]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.ticketPanels, panels);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <ConfirmProvider>{node}</ConfirmProvider>
      </QueryClientProvider>,
    ),
  );
  return { qc, unmount: () => act(async () => root.unmount()) };
}

async function open(p: TicketPanel = panel) {
  const onClose = vi.fn();
  const m = await mount(<RenamePanelDialog p={p} onClose={onClose} />);
  return { ...m, onClose };
}

const input = () => document.querySelector<HTMLInputElement>("[role=dialog] input")!;
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
async function type(value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("is in every panel's menu and opens on the panel's name", async () => {
  const { unmount } = await mount(<TicketPanelsSection admin />, [panel, { ...panel, id: "p2", kind: "shopify", name: "Margin Store", fields: [] }]);
  for (const name of ["Odoo", "Margin Store"]) {
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${name}"]`)!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const items = [...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent);
    expect(items[0]).toBe("Rename");
    await act(async () => (document.querySelector("[role=menuitem]") as HTMLElement).click());
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(`Rename ${name}`);
    expect(input().value).toBe(name);
    expect(input().maxLength).toBe(64);
    await act(async () => button("Cancel").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
  }
  expect(update).not.toHaveBeenCalled();
  await unmount();
});

it("saves the trimmed name, updates the list and says so", async () => {
  update.mockResolvedValue({ ...panel, name: "Odoo ERP" });
  const { qc, onClose, unmount } = await open();
  await type("  Odoo ERP  ");
  await act(async () => button("Save").click());
  expect(update).toHaveBeenCalledWith("p1", { name: "Odoo ERP" });
  expect(qc.getQueryData<TicketPanel[]>(qk.ticketPanels)?.[0].name).toBe("Odoo ERP");
  expect(toast.success).toHaveBeenCalledWith("Renamed to Odoo ERP");
  expect(onClose).toHaveBeenCalled();
  await unmount();
});

it("asks for a name, and sends nothing when it is unchanged", async () => {
  const { onClose, unmount } = await open();
  await type("   ");
  await act(async () => button("Save").click());
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("Enter a name.");
  expect(onClose).not.toHaveBeenCalled();
  await type(" Odoo ");
  await act(async () => button("Save").click());
  expect(update).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
  await unmount();
});

it("shows the server's refusal and stays open", async () => {
  update.mockRejectedValue(new ApiError({ status: 422, code: "invalid_name", title: "Invalid name", detail: "Name cannot contain a link, web address or email address." }));
  const { onClose, unmount } = await open();
  await type("erp.example.com");
  await act(async () => input().form!.requestSubmit());
  expect(update).toHaveBeenCalledWith("p1", { name: "erp.example.com" });
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("Name cannot contain a link");
  expect(toast.success).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await unmount();
});
