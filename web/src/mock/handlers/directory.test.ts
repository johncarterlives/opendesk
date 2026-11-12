import { describe, expect, it } from "vitest";
import type { Company, Contact } from "@/lib/api/types";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function post(path: string, body: unknown) {
  const ws = db.workspaces[0].workspace.id;
  const r = await dispatch(`http://mock${path}`, { method: "POST", body: JSON.stringify(body), headers: { "OD-Workspace": ws } });
  return { status: r.status, body: await r.json() };
}

async function list<T>(path: string): Promise<T[]> {
  const ws = db.workspaces[0].workspace.id;
  const r = await dispatch(`http://mock${path}`, { method: "GET", headers: { "OD-Workspace": ws } });
  return (await r.json()).data as T[];
}

describe("mock people and companies lists", () => {
  installMock();

  it("sorts people by name and tickets, and filters on blocked", async () => {
    const byName = await list<Contact>("/v1/contacts?sort=name&limit=100");
    const names = byName.map((c) => c.name.toLowerCase());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect((await list<Contact>("/v1/contacts?sort=-name&limit=100")).map((c) => c.id)).toEqual(byName.map((c) => c.id).reverse());

    const tickets = (await list<Contact>("/v1/contacts?sort=-tickets&limit=100")).map((c) => c.ticket_count);
    expect(tickets).toEqual([...tickets].sort((a, b) => b - a));

    db.workspaces[0].contacts[0].blocked = true;
    const blocked = await list<Contact>("/v1/contacts?blocked=true&limit=100");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((c) => c.blocked)).toBe(true);
    expect((await list<Contact>("/v1/contacts?blocked=false&limit=100")).some((c) => c.blocked)).toBe(false);
  });

  it("sorts companies by name, size and age", async () => {
    const asc = (await list<Company>("/v1/companies?limit=100")).map((c) => c.name.toLowerCase());
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b)));
    expect((await list<Company>("/v1/companies?sort=-name&limit=100")).map((c) => c.name.toLowerCase())).toEqual([...asc].reverse());
    const sizes = (await list<Company>("/v1/companies?sort=-contacts&limit=100")).map((c) => c.contact_count);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("labels, moves and deletes people by id or by filter, all or nothing", async () => {
    const people = db.workspaces[0].contacts;
    const first = people.slice(0, 3).map((c) => c.id);
    const company = db.workspaces[0].companies[0];

    expect((await post("/v1/contacts/bulk", { ids: first, patch: { add_tags: ["bulk-test"] } })).body).toEqual({ updated: 3, deleted: 0 });
    expect(people.filter((c) => c.tags.some((x) => x.name === "bulk-test")).map((c) => c.id).sort()).toEqual([...first].sort());
    await post("/v1/contacts/bulk", { ids: first.slice(0, 1), patch: { remove_tags: ["bulk-test"] } });
    expect(people.filter((c) => c.tags.some((x) => x.name === "bulk-test")).length).toBe(2);

    await post("/v1/contacts/bulk", { ids: first, patch: { company_id: company.id } });
    expect(people.filter((c) => first.includes(c.id)).every((c) => c.company?.id === company.id)).toBe(true);
    await post("/v1/contacts/bulk", { ids: first, patch: { company_id: null } });
    expect(people.filter((c) => first.includes(c.id)).every((c) => c.company === null)).toBe(true);

    // Refusals change nothing.
    const before = db.workspaces[0].contacts.length;
    expect((await post("/v1/contacts/bulk", { ids: [first[0], "nope"], delete: true })).status).toBe(404);
    expect((await post("/v1/contacts/bulk", { ids: first, delete: true, patch: {} })).status).toBe(422);
    expect((await post("/v1/contacts/bulk", { delete: true })).status).toBe(422);
    expect(db.workspaces[0].contacts.length).toBe(before);

    // A filter selects: delete the labelled ones.
    expect((await post("/v1/contacts/bulk", { query: { tag: "bulk-test" }, delete: true })).body).toEqual({ updated: 0, deleted: 2 });
    expect(db.workspaces[0].contacts.length).toBe(before - 2);
  });

  it("labels and deletes companies, leaving their people without one", async () => {
    const ws = db.workspaces[0];
    const target = ws.companies.find((c) => ws.contacts.some((p) => p.company?.id === c.id))!;
    expect((await post("/v1/companies/bulk", { ids: [target.id], patch: { add_tags: ["bulk-co"] } })).body).toEqual({ updated: 1, deleted: 0 });
    expect((await post("/v1/companies/bulk", { query: { tag: "bulk-co" }, delete: true })).body).toEqual({ updated: 0, deleted: 1 });
    expect(ws.companies.some((c) => c.id === target.id)).toBe(false);
    expect(ws.contacts.some((p) => p.company?.id === target.id)).toBe(false);
  });

  it("sets and clears a custom field by id, selects by a field filter, and refuses a bad value whole", async () => {
    const ws = db.workspaces[0];
    const ids = ws.contacts.slice(0, 2).map((c) => c.id);
    expect((await post("/v1/contacts/bulk", { ids, patch: { fields: { timezone: "Europe/Paris" } } })).body).toEqual({ updated: 2, deleted: 0 });
    const tagged = await post("/v1/contacts/bulk", {
      query: { fields: [{ key: "timezone", op: "eq", value: "Europe/Paris" }] },
      patch: { add_tags: ["paris"] },
    });
    expect(tagged.body.updated).toBeGreaterThanOrEqual(2);
    await post("/v1/contacts/bulk", { ids: ids.slice(0, 1), patch: { fields: { timezone: null } } });
    expect(ws.contacts.find((c) => c.id === ids[0])!.fields.timezone).toBeUndefined();

    const before = ws.contacts.map((c) => c.fields.nps);
    expect((await post("/v1/contacts/bulk", { ids, patch: { fields: { nps: "lots" } } })).status).toBe(422);
    expect((await post("/v1/contacts/bulk", { ids, patch: {} })).status).toBe(422);
    expect(ws.contacts.map((c) => c.fields.nps)).toEqual(before);
  });

  it("lists people without a company and sorts by last update", async () => {
    const none = await list<Contact>("/v1/contacts?company_id=none&limit=100");
    expect(none.every((c) => !c.company)).toBe(true);
    const updated = (await list<Contact>("/v1/contacts?sort=-updated&limit=100")).map((c) => Date.parse(c.updated_at));
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
  });
});
