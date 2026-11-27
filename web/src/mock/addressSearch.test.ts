import { describe, expect, it } from "vitest";
import { installMock } from "./index";
import { dispatch } from "./router";
import { db } from "./db";
import { addressHit, addressMatch, addressQuery } from "./tickets";

async function call(path: string) {
  const ws = db.workspaces[0].workspace.id;
  const r = await dispatch(`http://mock${path}`, { method: "GET", headers: { "OD-Workspace": ws } });
  return r.json();
}

describe("mock address search", () => {
  installMock();

  it("finds an address by itself, its local part, its domain and their starts", () => {
    for (const q of ["buyer@shop-one.example.com", "BUYER@shop-one.example.com", "buyer", "buy", "shop-one", "shop-one.example", "example.com"]) {
      expect(addressHit("buyer@shop-one.example.com", q), q).toBe(true);
    }
    for (const q of ["uyer", "one-shop", "seller@shop-one.example.com"]) expect(addressHit("buyer@shop-one.example.com", q), q).toBe(false);
    expect(addressQuery("refund order")).toBeNull();
    expect(addressQuery("#123")).toBeNull();
  });

  it("lists the tickets of a contact's domain first, in search, the ticket list and Ask AI", async () => {
    const ws = db.workspaces[0];
    const t = ws.tickets.find((x) => x.contact?.email && !x.spam && !ws.deletedTickets.has(x.id))!;
    const domain = t.contact!.email!.split("@")[1];
    const word = domain.split(".")[0];
    const search = await call(`/v1/search?q=${encodeURIComponent(domain)}`);
    expect(search.tickets.length).toBeLessThanOrEqual(8);
    // Address matches lead: none comes after a ticket that only mentions the domain.
    const byAddress = search.tickets.map((x: { id: string }) => addressMatch(ws, ws.tickets.find((y) => y.id === x.id)!, domain));
    expect(byAddress[0]).toBe(true);
    expect(byAddress.indexOf(false) === -1 || !byAddress.slice(byAddress.indexOf(false)).includes(true)).toBe(true);
    expect(search.contacts.some((c: { email: string }) => c.email?.endsWith(`@${domain}`))).toBe(true);
    const list = await call(`/v1/tickets?q=${encodeURIComponent(word)}&limit=100`);
    expect(list.data.some((x: { id: string }) => x.id === t.id)).toBe(true);
    const ai = await call(`/v1/ai/search?q=${encodeURIComponent(t.contact!.email!)}`);
    expect(ai.tickets[0].contact.email).toBe(t.contact!.email);
    expect(ai.contacts.some((c: { email: string }) => c.email === t.contact!.email)).toBe(true);
  });
});
