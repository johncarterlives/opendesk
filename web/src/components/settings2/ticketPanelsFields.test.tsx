import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n";
import type { TicketPanel } from "@/lib/api/types";
import { DEFAULT_SHOPIFY_FIELDS } from "@/lib/panelFields";
import { ShopifyFieldsDialog } from "./ticketPanels";

const update = vi.fn();
vi.mock("@/lib/api/endpoints", () => ({ api: { ticketPanels: { update: (...a: unknown[]) => update(...a) } } }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  update.mockReset();
});

const panel: TicketPanel = {
  id: "p1",
  kind: "shopify",
  name: "Margin Store",
  host: "margin-store.myshopify.com",
  auth: "client_credentials",
  client_id: "app-id",
  fields: [...DEFAULT_SHOPIFY_FIELDS],
  orders_shown: 5,
  enabled: true,
  position: 0,
  status: "connected",
  last_error: "",
  created_at: "2026-10-27T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
};

async function open(p: TicketPanel = panel) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <ShopifyFieldsDialog p={p} onClose={onClose} />
      </QueryClientProvider>,
    ),
  );
  const box = (label: string) => [...document.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!.querySelector("button")!;
  const preview = () => document.querySelector("[role=group][aria-labelledby]")!.textContent ?? "";
  const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
  return { box, preview, button, onClose, unmount: () => act(async () => root.unmount()) };
}

it("lists Shopify's fields by customer and order, checked as the panel shows them, beside a preview", async () => {
  const { box, preview, button, unmount } = await open();
  const legends = [...document.querySelectorAll("legend")].map((l) => l.textContent);
  expect(legends).toEqual(["Customer", "Each order"]);
  expect(box("Tags").getAttribute("aria-checked")).toBe("true");
  expect(box("Email in the store").getAttribute("aria-checked")).toBe("false");
  expect(box("Unit prices").getAttribute("aria-checked")).toBe("true");
  expect(preview()).toContain("newsletter");
  expect(preview()).toContain("#1039");
  expect((button("Use the defaults") as HTMLButtonElement).disabled).toBe(true);
  await unmount();
});

it("previews each change and saves the chosen fields and orders", async () => {
  update.mockResolvedValue({ ...panel, fields: ["email", "orders_count", "total_spent"], orders_shown: 1 });
  const { box, preview, button, onClose, unmount } = await open();
  await act(async () => box("Tags").click());
  expect(preview()).not.toContain("newsletter");
  await act(async () => box("Email in the store").click());
  expect(preview()).toContain("ada@example.com");

  // Unit prices go with their lines.
  await act(async () => box("Products").click());
  expect(preview()).not.toContain("Arco floor lamp");
  expect(box("Unit prices").hasAttribute("disabled")).toBe(true);
  expect(box("Unit prices").getAttribute("aria-checked")).toBe("false");

  for (const f of ["Payment status", "Fulfilment status", "City, country and shipping method", "Discount codes", "Refunded amount", "Tracking"]) {
    await act(async () => box(f).click());
  }
  expect(preview()).not.toMatch(/Brussels|WELCOME10|DHL|Paid|refunded/);
  await act(async () => button("1").click());
  expect(preview()).not.toContain("#1039");
  expect(preview()).toContain("#1042");
  expect((button("Use the defaults") as HTMLButtonElement).disabled).toBe(false);

  await act(async () => button("Save").click());
  expect(update).toHaveBeenCalledWith("p1", { fields: ["email", "orders_count", "total_spent"], orders_shown: 1 });
  expect(onClose).toHaveBeenCalled();
  await unmount();
});

it("goes back to the defaults", async () => {
  const { box, button, unmount } = await open({ ...panel, fields: ["email"], orders_shown: 2 });
  expect(box("Tags").getAttribute("aria-checked")).toBe("false");
  await act(async () => button("Use the defaults").click());
  expect(box("Tags").getAttribute("aria-checked")).toBe("true");
  expect(box("Email in the store").getAttribute("aria-checked")).toBe("false");
  expect(button("5").getAttribute("aria-checked")).toBe("true");
  await unmount();
});
