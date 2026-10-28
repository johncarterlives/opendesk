import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import "@/i18n";
import type { TicketPanel } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { panelAnchor, ShopifyPanelCard } from "./ticketPanels";

vi.mock("@/lib/api/endpoints", () => ({ api: { ticketPanels: { list: () => new Promise(() => {}) } } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const panel: TicketPanel = {
  id: "p1",
  kind: "shopify",
  name: "Margin Store",
  host: "margin-store.myshopify.com",
  auth: "client_credentials",
  client_id: "app-id",
  fields: ["tags", "orders_count", "total_spent", "financial_status", "fulfillment_status", "line_items", "line_prices", "shipping", "discounts", "refunds", "tracking"],
  orders_shown: 5,
  enabled: true,
  position: 0,
  status: "connected",
  last_error: "",
  created_at: "2026-10-27T10:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
};

async function render(panels: TicketPanel[], admin = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.ticketPanels, panels);
  const onAdd = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <ShopifyPanelCard admin={admin} onAdd={onAdd} />
      </QueryClientProvider>,
    ),
  );
  return { host, onAdd, unmount: () => act(async () => root.unmount()) };
}

it("offers Shopify in the catalog and opens the ticket panel's dialog", async () => {
  const { host, onAdd, unmount } = await render([]);
  expect(host.textContent).toContain("Shopify");
  expect(host.textContent).toContain("Ticket panel");
  expect(host.textContent).toContain("last orders beside each ticket");
  const connect = [...host.querySelectorAll("button")].find((b) => b.textContent === "Connect")!;
  await act(async () => connect.click());
  expect(onAdd).toHaveBeenCalledTimes(1);
  await unmount();
});

it("says Connected once a store is, and leads to its row", async () => {
  const row = document.createElement("div");
  row.id = panelAnchor("p1");
  row.tabIndex = -1;
  const scroll = vi.fn();
  row.scrollIntoView = scroll;
  document.body.appendChild(row);
  const { host, onAdd, unmount } = await render([{ ...panel, kind: "http", id: "h1" }, panel]);
  const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Connected")!;
  expect(btn).toBeTruthy();
  expect(btn.title).toBe("Show Margin Store in ticket panels");
  await act(async () => btn.click());
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(row);
  expect(onAdd).not.toHaveBeenCalled();
  await unmount();
});

it("shows no Connect button to someone who is not an admin", async () => {
  const { host, unmount } = await render([], false);
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Connect")).toBe(false);
  await unmount();
});
