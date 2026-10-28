import { describe, expect, it } from "vitest";
import { DEFAULT_REFERENCE_PATTERN } from "@/lib/panelReferences";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock ticket panels", () => {
  installMock();

  it("lists the seeded store and reads a ticket's contact from it", async () => {
    const panels = (await call("GET", "/v1/ticket-panels")).body.data as { id: string; kind: string }[];
    const shop = panels.find((p) => p.kind === "shopify")!;
    expect(shop).toBeTruthy();
    const tickets = (await call("GET", "/v1/tickets")).body.data as { id: string; contact: { email: string | null } | null }[];
    const withEmail = tickets.find((t) => t.contact?.email)!;
    const d = (await call("GET", `/v1/tickets/${withEmail.id}/panels/${shop.id}`)).body;
    expect(["ok", "empty"]).toContain(d.state);
    if (d.state === "ok") {
      expect(d.orders.length).toBeGreaterThan(0);
      expect(d.orders[0].items[0].price).toMatch(/^\d+\.\d\d$/);
      expect(d.orders[0].shipping).toMatchObject({ city: expect.any(String), country: expect.stringMatching(/^[A-Z]{2}$/) });
      expect(Array.isArray(d.orders[0].discount_codes)).toBe(true);
    }
  });

  it("shows the fields and orders the panel chose, for Shopify panels only", async () => {
    const panels = (await call("GET", "/v1/ticket-panels")).body.data as { id: string; kind: string; fields: string[]; orders_shown: number }[];
    const shop = panels.find((p) => p.kind === "shopify")!;
    expect(shop.fields).toEqual(["tags", "orders_count", "total_spent", "financial_status", "fulfillment_status", "line_items", "line_prices", "shipping", "discounts", "refunds", "tracking"]);
    expect(shop.orders_shown).toBe(5);
    const tickets = (await call("GET", "/v1/tickets")).body.data as { id: string; contact: { email: string | null } | null }[];
    const ids = tickets.filter((t) => t.contact?.email).map((t) => t.id);
    const read = async () => {
      for (const id of ids) {
        const d = (await call("GET", `/v1/tickets/${id}/panels/${shop.id}`)).body;
        if (d.state === "ok" && d.orders.length > 1) return d;
      }
      throw new Error("no contact the store knows with orders");
    };
    const full = await read();
    expect(full.customer.tags.length).toBeGreaterThan(0);
    expect(full.customer.email).toBeUndefined();
    expect(full.orders[0].items[0].price).toBeDefined();

    const path = `/v1/ticket-panels/${shop.id}`;
    expect((await call("PATCH", path, { fields: ["tags", "street"] })).status).toBe(422);
    expect((await call("PATCH", path, { fields: ["line_prices"] })).status).toBe(422);
    expect((await call("PATCH", path, { orders_shown: 6 })).status).toBe(422);
    const upd = (await call("PATCH", path, { fields: ["line_items", "email", "line_items"], orders_shown: 1 })).body;
    expect(upd.fields).toEqual(["email", "line_items"]);
    expect(upd.orders_shown).toBe(1);
    const few = await (async () => {
      for (const id of ids) {
        const d = (await call("GET", `/v1/tickets/${id}/panels/${shop.id}`)).body;
        if (d.state === "ok") return d;
      }
      throw new Error("no contact the store knows");
    })();
    expect(few.customer.tags).toEqual([]);
    expect(few.customer.email).toMatch(/@/);
    expect(few.customer.orders_count).toBeUndefined();
    expect(few.orders).toHaveLength(1);
    expect(few.orders[0].financial_status).toBeUndefined();
    expect(few.orders[0].shipping).toBeUndefined();
    expect(few.orders[0].items[0].price).toBeUndefined();
    expect(few.orders[0].tracking).toEqual([]);
    await call("PATCH", path, { fields: shop.fields, orders_shown: 5 });

    const made = await call("POST", "/v1/ticket-panels", { kind: "http", url: "https://erp.example.com/fields" });
    expect(made.body.panel.fields).toEqual([]);
    expect((await call("PATCH", `/v1/ticket-panels/${made.body.panel.id}`, { fields: ["tags"] })).status).toBe(422);
    expect((await call("POST", "/v1/ticket-panels", { kind: "http", url: "https://erp.example.com/x", orders_shown: 2 })).status).toBe(422);
    await call("DELETE", `/v1/ticket-panels/${made.body.panel.id}`);
  });

  it("adds an http panel with a secret shown once, refuses bad input, and removes it", async () => {
    expect((await call("POST", "/v1/ticket-panels", { kind: "http", url: "ftp://erp.example.com" })).status).toBe(422);
    expect((await call("POST", "/v1/ticket-panels", { kind: "shopify", shop: "evil.example.com", token: "x" })).status).toBe(422);
    expect((await call("POST", "/v1/ticket-panels", { kind: "shopify", shop: "lumen-store", token: "x", reference_pattern: "x" })).status).toBe(422);
    const made = await call("POST", "/v1/ticket-panels", { kind: "http", url: "https://erp.example.com/panel", name: "Odoo" });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^pnsec_/);
    expect(made.body.panel).toMatchObject({ kind: "http", name: "Odoo", host: "erp.example.com" });
    const tickets = (await call("GET", "/v1/tickets")).body.data as { id: string }[];
    const d = (await call("GET", `/v1/tickets/${tickets[0]!.id}/panels/${made.body.panel.id}`)).body;
    expect(d.sections).toBeUndefined();
    expect(d.blocks.map((b: { type: string }) => b.type)).toEqual(["card", "card", "fields", "list", "note"]);
    expect(d.blocks[0].links).toHaveLength(2);
    expect([d.blocks[0].collapsed, d.blocks[1].collapsed]).toEqual([undefined, true]);
    expect(made.body.panel.reference_pattern).toBe(DEFAULT_REFERENCE_PATTERN);
    expect((await call("PATCH", `/v1/ticket-panels/${made.body.panel.id}`, { reference_pattern: "(unclosed" })).status).toBe(422);
    expect((await call("PATCH", `/v1/ticket-panels/${made.body.panel.id}`, { reference_pattern: "x?" })).status).toBe(422);
    expect((await call("PATCH", `/v1/ticket-panels/${made.body.panel.id}`, { reference_pattern: "" })).body.reference_pattern).toBe("");
    const off = await call("PATCH", `/v1/ticket-panels/${made.body.panel.id}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    expect((await call("GET", `/v1/tickets/${tickets[0]!.id}/panels/${made.body.panel.id}`)).status).toBe(404);
    expect((await call("DELETE", `/v1/ticket-panels/${made.body.panel.id}`)).status).toBe(204);
  });

  it("connects a store with an app's client ID and secret, or a token, and keeps the client ID on a new secret", async () => {
    const base = { kind: "shopify", shop: "lumen-store" };
    expect((await call("POST", "/v1/ticket-panels", { ...base, client_id: "app-id" })).status).toBe(422);
    expect((await call("POST", "/v1/ticket-panels", { ...base, client_id: "app-id", client_secret: "s", token: "shpat_x" })).status).toBe(422);
    const made = await call("POST", "/v1/ticket-panels", { ...base, client_id: "app-id", client_secret: "s" });
    expect(made.body.panel).toMatchObject({ auth: "client_credentials", client_id: "app-id" });
    expect(JSON.stringify(made.body)).not.toContain('"s"');
    const id = made.body.panel.id;
    expect((await call("PATCH", `/v1/ticket-panels/${id}`, { client_secret: "s2" })).body).toMatchObject({ auth: "client_credentials", client_id: "app-id" });
    const token = (await call("PATCH", `/v1/ticket-panels/${id}`, { token: "shpat_old" })).body;
    expect(token.auth).toBe("access_token");
    expect(token.client_id).toBeUndefined();
    expect((await call("PATCH", `/v1/ticket-panels/${id}`, { client_secret: "s3" })).status).toBe(422);
    await call("DELETE", `/v1/ticket-panels/${id}`);
  });
});
