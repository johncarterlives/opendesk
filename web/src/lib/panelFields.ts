// The fields of Shopify's answer a ticket panel shows (contracts/integrations.md "Ticket panels"):
// the catalogue, its defaults, and an answer cut down to a panel's choice. The customer's name and
// link, and each order's number, date, total and cancellation, always show.

import type { ShopifyField, TicketPanel, TicketPanelData } from "@/lib/api/types";

export const CUSTOMER_FIELDS = ["tags", "email", "orders_count", "total_spent"] as const satisfies readonly ShopifyField[];
export const ORDER_FIELDS = ["financial_status", "fulfillment_status", "line_items", "line_prices", "shipping", "discounts", "refunds", "tracking"] as const satisfies readonly ShopifyField[];
/** The catalogue, in the order settings lists it. */
export const SHOPIFY_FIELDS: readonly ShopifyField[] = [...CUSTOMER_FIELDS, ...ORDER_FIELDS];
/** What a panel shows until an admin chooses: everything but the email, the ticket's contact's own. */
export const DEFAULT_SHOPIFY_FIELDS: readonly ShopifyField[] = SHOPIFY_FIELDS.filter((f) => f !== "email");
export const MAX_ORDERS_SHOWN = 5;

export function isShopifyField(v: unknown): v is ShopifyField {
  return typeof v === "string" && (SHOPIFY_FIELDS as readonly string[]).includes(v);
}

/** A choice as the server keeps it: catalogue order, no repeats; unit prices show on their lines, so they go with them. */
export function normalizeFields(fields: Iterable<ShopifyField>): ShopifyField[] {
  const on = new Set(fields);
  if (!on.has("line_items")) on.delete("line_prices");
  return SHOPIFY_FIELDS.filter((f) => on.has(f));
}

/** The fields a panel shows, and how many orders. */
export function panelShows(p: Pick<TicketPanel, "fields" | "orders_shown">): { fields: readonly ShopifyField[]; ordersShown: number } {
  return { fields: p.fields ?? DEFAULT_SHOPIFY_FIELDS, ordersShown: p.orders_shown ?? MAX_ORDERS_SHOWN };
}

/** A Shopify answer with only these fields: the others left out, their lists empty, at most `ordersShown` orders. */
export function shownData(d: TicketPanelData, fields: readonly ShopifyField[], ordersShown = MAX_ORDERS_SHOWN): TicketPanelData {
  if (d.kind !== "shopify") return d;
  const on = new Set(fields);
  const c = d.customer;
  return {
    ...d,
    customer: c && {
      name: c.name,
      url: c.url,
      tags: on.has("tags") ? c.tags : [],
      ...(on.has("email") && c.email ? { email: c.email } : {}),
      ...(on.has("orders_count") && c.orders_count !== undefined ? { orders_count: c.orders_count } : {}),
      ...(on.has("total_spent") && c.total_spent ? { total_spent: c.total_spent, currency: c.currency } : {}),
    },
    orders: d.orders?.slice(0, Math.max(1, ordersShown)).map((o) => ({
      id: o.id,
      number: o.number,
      url: o.url,
      created_at: o.created_at,
      total: o.total,
      currency: o.currency,
      cancelled: o.cancelled,
      ...(o.cancelled_at ? { cancelled_at: o.cancelled_at } : {}),
      ...(on.has("financial_status") && o.financial_status ? { financial_status: o.financial_status } : {}),
      ...(on.has("fulfillment_status") && o.fulfillment_status ? { fulfillment_status: o.fulfillment_status } : {}),
      ...(on.has("refunds") && o.refunded ? { refunded: o.refunded } : {}),
      ...(on.has("shipping") && o.shipping ? { shipping: o.shipping } : {}),
      discount_codes: on.has("discounts") ? o.discount_codes : [],
      items: on.has("line_items") ? o.items.map(({ price, ...it }) => (on.has("line_prices") && price ? { ...it, price } : it)) : [],
      tracking: on.has("tracking") ? o.tracking : [],
    })),
  };
}
