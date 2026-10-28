import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PanelBlock, PanelOrder, PanelValue, ShopifyField, TicketPanelData } from "@/lib/api/types";
import { panelDate, relDay } from "@/lib/format";
import { DEFAULT_SHOPIFY_FIELDS, normalizeFields, shownData } from "@/lib/panelFields";
import { PanelBody, shippingLine } from "./TicketPanels";

const order = (patch: Partial<PanelOrder> = {}): PanelOrder => ({
  id: "gid://shopify/Order/1001",
  number: "#1042",
  url: "https://admin.shopify.com/store/lumen-store/orders/1001",
  created_at: "2026-10-20T09:00:00Z",
  total: "119.32",
  currency: "EUR",
  financial_status: "partially_refunded",
  fulfillment_status: "fulfilled",
  cancelled: false,
  refunded: "14.44",
  discount_codes: ["WELCOME10"],
  shipping: { city: "Brussels", country: "BE", method: "DHL Express" },
  items: [
    { title: "Lucide Leanne Wall Lamp", variant: "Black", quantity: 3, price: "14.44" },
    { title: "LED bulb E27", quantity: 1, price: "12.90" },
  ],
  tracking: [{ company: "DHL", number: "JD0123", url: "https://dhl.example/track/JD0123" }],
  ...patch,
});

const data = (orders: PanelOrder[]): TicketPanelData => ({
  panel_id: "p1",
  kind: "shopify",
  state: "ok",
  fetched_at: "2026-10-27T10:00:00Z",
  customer: {
    name: "Ada Buyer",
    url: "https://admin.shopify.com/store/lumen-store/customers/42",
    email: "ada@example.com",
    orders_count: 3,
    total_spent: "412.50",
    currency: "EUR",
    tags: ["footer_signup", "newsletter"],
  },
  orders,
});

// The rendered text, read through the DOM rather than by stripping tags.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

describe("Shopify ticket panel", () => {
  it("shows each line with its unit price, where the order goes and how, codes, refunds and tracking", () => {
    const html = renderToStaticMarkup(<PanelBody data={data([order()])} />);
    const t = text(html);
    expect(t).toContain("3×Lucide Leanne Wall Lamp - Black€14.44");
    expect(t).toContain("LED bulb E27€12.90");
    expect(t).toContain("Brussels, Belgium · DHL Express");
    expect(t).toContain("WELCOME10");
    expect(t).toContain("€14.44 refunded");
    expect(t).toContain("Partly refunded");
    expect(t).toContain("DHL · JD0123");
    // The order number opens the order in Shopify admin.
    expect(html).toMatch(/<a href="https:\/\/admin\.shopify\.com\/store\/lumen-store\/orders\/1001"[^>]*title="Open order #1042 in Shopify"/);
  });

  it("marks a cancelled order with its date and leaves out what is not there", () => {
    const t = text(
      renderToStaticMarkup(
        <PanelBody
          data={data([
            order({
              cancelled: true,
              cancelled_at: "2026-09-03T08:30:00Z",
              financial_status: "refunded",
              fulfillment_status: "unfulfilled",
              refunded: undefined,
              discount_codes: [],
              shipping: undefined,
              tracking: [],
            }),
          ])}
        />,
      ),
    );
    expect(t).toMatch(/Cancelled Sep 3/);
    expect(t).toContain("Refunded");
    expect(t).not.toContain("Unfulfilled");
    expect(t).not.toContain("refunded€");
    expect(t).not.toContain("DHL Express");
  });

  it("shows what it always has until an admin chooses, the email aside", () => {
    const t = text(renderToStaticMarkup(<PanelBody data={data([order(), order({ id: "o2", number: "#1041" })])} />));
    expect(t).toContain("footer_signup");
    expect(t).toContain("3 orders · €412.50 spent");
    expect(t).not.toContain("ada@example.com");
    expect(t).toContain("#1041");
  });

  it("shows only the fields the panel shows, and as many orders", () => {
    const two = data([order(), order({ id: "o2", number: "#1041" })]);
    const render = (fields: ShopifyField[], ordersShown?: number) => text(renderToStaticMarkup(<PanelBody data={two} fields={fields} ordersShown={ordersShown} />));

    // Nothing chosen: the customer's name and each order's number, date and total.
    const bare = render([]);
    expect(bare).toContain("Ada Buyer");
    expect(bare).toContain("#1042");
    expect(bare).toContain("€119.32");
    for (const gone of ["footer_signup", "orders", "spent", "Partly refunded", "Fulfilled", "Lucide", "Brussels", "WELCOME10", "refunded", "DHL"]) expect(bare).not.toContain(gone);

    // Lines without their prices; the store's email; the spend without the count.
    const some = render(["email", "total_spent", "line_items"], 1);
    expect(some).toContain("ada@example.com");
    expect(some).toContain("€412.50 spent");
    expect(some).not.toContain("3 orders");
    expect(some).toContain("3×Lucide Leanne Wall Lamp - Black");
    expect(some).not.toContain("€14.44");
    expect(some).not.toContain("#1041");

    // Each order field on its own.
    expect(render(["financial_status"])).toContain("Partly refunded");
    expect(render(["fulfillment_status"])).toContain("Fulfilled");
    expect(render(["line_items", "line_prices"])).toContain("€12.90");
    expect(render(["shipping"])).toContain("Brussels, Belgium · DHL Express");
    expect(render(["discounts"])).toContain("WELCOME10");
    expect(render(["refunds"])).toContain("€14.44 refunded");
    expect(render(["tracking"])).toContain("DHL · JD0123");
    expect(render(["tags"])).toContain("newsletter");
  });

  it("cuts an answer to the panel's choice, the way the mock and the server do", () => {
    const d = shownData(data([order(), order({ id: "o2" })]), ["line_items", "line_prices", "email"], 1);
    expect(d.customer).toEqual({ name: "Ada Buyer", url: "https://admin.shopify.com/store/lumen-store/customers/42", tags: [], email: "ada@example.com" });
    expect(d.orders).toHaveLength(1);
    expect(d.orders![0]).not.toHaveProperty("financial_status");
    expect(d.orders![0]).not.toHaveProperty("shipping");
    expect(d.orders![0].items[0].price).toBe("14.44");
    expect(d.orders![0].tracking).toEqual([]);
    expect(normalizeFields(["tracking", "line_prices", "tags", "tags"])).toEqual(["tags", "tracking"]);
    expect(DEFAULT_SHOPIFY_FIELDS).not.toContain("email");
  });

  it("writes the destination from what the store knows", () => {
    expect(shippingLine({ city: "Lyon", country: "FR" })).toBe("Lyon, France");
    expect(shippingLine({ method: "Pickup" })).toBe("Pickup");
    expect(shippingLine(undefined)).toBe("");
  });
});

const httpData = (blocks: PanelBlock[]): TicketPanelData => ({ panel_id: "p2", kind: "http", state: "ok", fetched_at: "2026-10-27T10:00:00Z", blocks });
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("URL ticket panel", () => {
  it("shows a card: its link, badges, fields, lines and footer, dates and money in the reader's locale", () => {
    const html = renderToStaticMarkup(
      <PanelBody
        data={httpData([
          {
            type: "card",
            title: "Sales order S00042",
            url: "https://erp.example.com/so/42",
            subtitle: "Ships from Milan",
            badges: [
              { text: "Supplier late", tone: "warning" },
              { text: "Paid", tone: "success" },
              { text: "VIP", tone: "info" },
            ],
            fields: [
              { label: "Supplier date", value: { type: "date", value: inDays(3), relative: true } },
              { label: "Supplier", value: { type: "text", text: "Flos S.p.A." }, url: "https://erp.example.com/p/88" },
            ],
            lines: [{ quantity: 2, title: "Arco floor lamp", subtitle: "Marble", value: { type: "money", amount: "1890.00", currency: "EUR" } }],
            footer: [{ label: "Total", value: { type: "money", amount: "3780", currency: "EUR" } }],
          },
        ])}
      />,
    );
    const t = text(html);
    expect(html).toMatch(/<article[^>]*aria-label="Sales order S00042"/);
    expect(html).toMatch(/<a href="https:\/\/erp\.example\.com\/so\/42"[^>]*rel="noopener noreferrer"[^>]*title="Open Sales order S00042"/);
    expect(t).toContain("Ships from Milan");
    expect(t).toContain("Supplier late");
    expect(t).toContain("in 3 days");
    expect(html).toContain(`dateTime="${inDays(3)}"`);
    expect(html).toMatch(/<a href="https:\/\/erp\.example\.com\/p\/88"[^>]*>Flos S\.p\.A\.<\/a>/);
    expect(t).toContain("2×Arco floor lamp - Marble€1,890.00");
    expect(t).toContain("Total€3,780.00");
    // The tones are the badges' own: warning amber, success green, info blue.
    expect(html).toContain("tone-amber");
    expect(html).toContain("tone-green");
    expect(html).toContain("tone-blue");
  });

  it("shows fields, lists and notes, a day as that day and a time in the reader's timezone", () => {
    const t = text(
      renderToStaticMarkup(
        <PanelBody
          data={httpData([
            {
              type: "fields",
              title: "Subscription",
              items: [
                { label: "Plan", value: { type: "badge", text: "Pro yearly", tone: "info" } },
                { label: "Started", value: { type: "date", value: "2026-11-04" } },
                { label: "Seats", value: { type: "text", text: "12" } },
              ],
            },
            {
              type: "list",
              title: "Invoices",
              items: [
                { title: "INV/2026/00012", subtitle: "Pro yearly", url: "https://erp.example.com/inv/12", value: { type: "money", amount: "490", currency: "EUR" }, badge: { text: "Overdue", tone: "danger" } },
                { title: "INV/2026/00009" },
              ],
            },
            { type: "note", text: "No open credit note.", tone: "neutral" },
          ])}
        />,
      ),
    );
    expect(t).toContain("SubscriptionPlanPro yearlyStartedNov 4");
    expect(t).not.toContain("Nov 3");
    expect(t).toContain("Seats12");
    expect(t).toContain("InvoicesINV/2026/00012Pro yearly€490.00Overdue");
    expect(t).toContain("INV/2026/00009");
    expect(t).toContain("No open credit note.");
    expect(panelDate("2026-11-04T10:30:00Z")).toMatch(/Nov 4/);
  });

  it("skips a block or a value type it does not know", () => {
    const html = renderToStaticMarkup(
      <PanelBody
        data={httpData([
          { type: "chart", points: [1, 2] } as unknown as PanelBlock,
          { type: "fields", items: [{ label: "Odd", value: { type: "video", src: "x" } as unknown as PanelValue }] },
          { type: "note", text: "Still here.", tone: "warning" },
        ])}
      />,
    );
    expect(text(html)).toBe("OddStill here.");
  });

  it("shows a card's links as small buttons by its title: a shipped logo, a drawn icon or the label's letter", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <PanelBody
          data={httpData([
            {
              type: "card",
              title: "Order #1042",
              url: "https://erp.example.com/so/42",
              links: [
                { label: "Open in the shop", url: "https://admin.shopify.com/store/lumen-store/orders/1001", icon: "shopify" },
                { label: "Open in the ERP", url: "https://erp.example.com/odoo/sales/42", icon: "receipt" },
                { label: "carrier", url: "https://carrier.example/t/JD0123" },
                { label: "Odd", url: "https://odd.example/x", icon: "rocket" },
              ],
            },
            { type: "list", items: [{ title: "INV/2026/00012", links: [{ label: "PDF", url: "https://billing.example.com/inv/12.pdf", icon: "file-text" }] }] },
          ])}
        />
      </TooltipProvider>,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = [...doc.querySelectorAll("article a[aria-label]")];
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual(["Open in the shop", "Open in the ERP", "carrier", "Odd"]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(links[0].getAttribute("href")).toBe("https://admin.shopify.com/store/lumen-store/orders/1001");
    // The title keeps its own link.
    expect(doc.querySelector('h4 a[href="https://erp.example.com/so/42"]')).not.toBeNull();
    // Shopify's shipped logo, the receipt drawn as an icon, a letter for no icon or one the app does not know.
    expect(links[0].querySelector("img")?.getAttribute("src")).toBe("/logos/apps/shopify.svg");
    expect(links[1].querySelector("svg.lucide-receipt")).not.toBeNull();
    expect(links[2].textContent).toBe("C");
    expect(links[3].textContent).toBe("O");
    expect(links[3].querySelector("img")).toBeNull();
    // Nothing but the app's own pictures.
    for (const img of doc.querySelectorAll("img")) expect(img.getAttribute("src")).toMatch(/^\/logos\/apps\//);
    const row = doc.querySelector('a[aria-label="PDF"]');
    expect(row?.getAttribute("href")).toBe("https://billing.example.com/inv/12.pdf");
    expect(row?.querySelector("svg.lucide-file-text")).not.toBeNull();
  });

  it("folds a collapsed card to its header until it is opened, and shows any other card open", async () => {
    const card = (title: string, collapsed?: boolean): PanelBlock => ({
      type: "card",
      title,
      collapsed,
      subtitle: "Placed Oct 2",
      badges: [{ text: "Delivered", tone: "success" }],
      links: [{ label: "Open in the shop", url: "https://shop.example/o/1", icon: "store" }],
      fields: [{ label: "Carrier", value: { type: "text", text: "DHL" } }],
      lines: [{ quantity: 1, title: "Arco floor lamp" }],
      footer: [{ label: "Total", value: { type: "money", amount: "1890", currency: "EUR" } }],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <PanelBody data={httpData([card("Order #1042", false), card("Order #1041", true), { type: "card", title: "Order #1040", collapsed: true, subtitle: "Header only" }])} />
        </TooltipProvider>,
      ),
    );
    const [open, folded, bare] = [...host.querySelectorAll("article")];
    // An open card has no fold button and shows everything.
    expect(open.querySelector("button[aria-expanded]")).toBeNull();
    expect(open.textContent).toContain("CarrierDHL");
    // A folded card shows its title, links, subtitle and badges, and a button that says it is closed.
    const toggle = folded.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show Order #1041");
    expect(folded.textContent).toContain("Order #1041");
    expect(folded.textContent).toContain("Placed Oct 2");
    expect(folded.textContent).toContain("Delivered");
    expect(folded.querySelector('a[aria-label="Open in the shop"]')).not.toBeNull();
    expect(folded.textContent).not.toContain("DHL");
    expect(folded.textContent).not.toContain("Arco floor lamp");
    expect(folded.textContent).not.toContain("Total");
    // Opening it shows the rest; closing it folds it again.
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide Order #1041");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toContain("CarrierDHL1×Arco floor lampTotal€1,890.00");
    await act(async () => toggle.click());
    expect(folded.textContent).not.toContain("DHL");
    // A collapsed card with nothing under its header has nothing to open.
    expect(bare.querySelector("button")).toBeNull();
    expect(bare.textContent).toContain("Header only");
    await act(async () => root.unmount());
    host.remove();
  });

  it("says how far a day is", () => {
    expect(relDay(inDays(0))).toBe("today");
    expect(relDay(inDays(1))).toBe("tomorrow");
    expect(relDay(inDays(-5))).toBe("5 days ago");
    expect(relDay(inDays(61))).toBe("in 2 months");
    expect(relDay("not a date")).toBe("");
  });

  it("shows a version 1 answer as it always has", () => {
    const html = renderToStaticMarkup(
      <PanelBody
        data={{
          panel_id: "p3",
          kind: "http",
          state: "ok",
          fetched_at: "2026-10-27T10:00:00Z",
          sections: [{ title: "Sales order", items: [{ label: "Confirmed delivery", value: "2026-11-04", url: "https://erp.example.com/so/42" }, { label: "Supplier", value: "Flos" }] }],
        }}
      />,
    );
    expect(html).toBe(
      '<div class="flex flex-col gap-2.5"><div class="flex flex-col gap-1"><h4 class="text-[11.5px] font-medium text-fg-2">Sales order</h4><dl class="flex flex-col gap-0.5">' +
        '<div class="flex items-baseline gap-2 text-[12px]"><dt class="w-2/5 shrink-0 truncate text-fg-4">Confirmed delivery</dt><dd class="min-w-0 flex-1 break-words text-fg-2">' +
        '<a href="https://erp.example.com/so/42" target="_blank" rel="noopener noreferrer" class="outline-none hover:underline focus-visible:underline">2026-11-04</a></dd></div>' +
        '<div class="flex items-baseline gap-2 text-[12px]"><dt class="w-2/5 shrink-0 truncate text-fg-4">Supplier</dt><dd class="min-w-0 flex-1 break-words text-fg-2">Flos</dd></div></dl></div></div>',
    );
  });
});
