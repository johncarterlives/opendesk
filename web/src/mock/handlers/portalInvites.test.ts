import { describe, expect, it } from "vitest";
import type { Contact, PortalAccess, PortalBulkInvite } from "@/lib/api/types";
import { invitable } from "@/components/contacts/PortalAccess";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock portal invitations", () => {
  installMock();
  const ws = () => db.workspaces[0];
  const fresh = () => ws().contacts.find((c) => c.email && !c.blocked && ws().contacts.indexOf(c) > 4) as Contact;

  it("seeds one customer with access and one invited", async () => {
    const statuses = await Promise.all(ws().contacts.slice(0, 6).map(async (c) => ((await call("GET", `/v1/contacts/${c.id}/portal`)).body as PortalAccess).status));
    expect(statuses).toContain("active");
    expect(statuses).toContain("invited");
  });

  it("invites, then removes access", async () => {
    const c = fresh();
    const url = `/v1/contacts/${c.id}/portal`;
    expect(((await call("GET", url)).body as PortalAccess).status).toBe("none");
    const sent = await call("POST", `${url}/invite`, {});
    expect(sent.status).toBe(200);
    expect((sent.body as PortalAccess).status).toBe("invited");
    expect((await call("DELETE", url)).status).toBe(204);
    expect(((await call("GET", url)).body as PortalAccess).status).toBe("none");
  });

  it("refuses a contact without email or blocked, and counts them in bulk", async () => {
    const noEmail = ws().contacts.find((c) => !c.email);
    const blocked = ws().contacts.find((c) => c.blocked);
    if (noEmail) expect((await call("POST", `/v1/contacts/${noEmail.id}/portal/invite`, {})).status).toBe(422);
    if (blocked) expect((await call("POST", `/v1/contacts/${blocked.id}/portal/invite`, {})).status).toBe(422);
    const ids = [fresh().id, ...(noEmail ? [noEmail.id] : []), ...(blocked ? [blocked.id] : []), "nope"];
    const r = (await call("POST", "/v1/contacts/portal/invite", { ids })).body as PortalBulkInvite;
    expect(r.sent).toBe(1);
    expect(r.skipped.not_found).toBe(1);
  });

  it("offers only brands whose customers choose a password", () => {
    expect(invitable([{ id: "a", name: "A", slug: "a", auth_mode: "oidc", default: true }, { id: "b", name: "B", slug: "b", auth_mode: "local_and_oidc", default: false }]).map((b) => b.id)).toEqual(["b"]);
  });
});
