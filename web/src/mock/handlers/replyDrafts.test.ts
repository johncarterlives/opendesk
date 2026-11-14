import { describe, expect, it } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: ws ? { "OD-Workspace": ws } : {},
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock reply drafts", () => {
  installMock();

  it("keeps my unsent reply, replaces it, and drops it when sent or emptied", async () => {
    const t = db.workspaces[0]!.tickets.find((x) => x.channel === "email")!;
    const path = `/v1/tickets/${t.id}/reply-draft`;
    expect((await call("GET", path)).body.draft).toBeNull();

    const saved = await call("PUT", path, { body_html: "<p>Half a reply</p>", attachment_ids: [] });
    expect(saved.body.draft).toMatchObject({ ticket_id: t.id, body_html: "<p>Half a reply</p>" });
    await call("PUT", path, { body_html: "<p>More of it</p>", attachment_ids: [] });
    expect((await call("GET", path)).body.draft.body_html).toBe("<p>More of it</p>");

    // Sending a reply ends it.
    await call("POST", `/v1/tickets/${t.id}/messages`, { kind: "reply", body_html: "<p>Sent</p>" });
    expect((await call("GET", path)).body.draft).toBeNull();

    // Saving nothing discards it.
    await call("PUT", path, { body_html: "<p>again</p>" });
    expect((await call("PUT", path, { body_html: "<p> </p>" })).body.draft).toBeNull();
    await call("PUT", path, { body_html: "<p>and again</p>" });
    expect((await call("DELETE", path)).status).toBe(204);
    expect((await call("GET", path)).body.draft).toBeNull();
  });
  it("schedules, moves, preserves across another reply, cancels and sends now once", async () => {
    const ticket = db.workspaces[0]!.tickets.find((x) => x.channel === "email")!;
    const path = `/v1/tickets/${ticket.id}/reply-draft`;
    const at = new Date(Date.now() + 3600000).toISOString();
    const reply = { kind: "reply", body_html: "<p>Later</p>" };
    expect((await call("POST", `${path}/schedule`, { send_at: at, reply })).status).toBe(200);
    expect((await call("PUT", path, { body_html: "overwrite" })).status).toBe(422);
    await call("POST", `/v1/tickets/${ticket.id}/messages`, { kind: "reply", body_html: "<p>First</p>" });
    expect((await call("GET", path)).body.draft.schedule.send_at).toBe(at);
    const later = new Date(Date.now() + 7200000).toISOString();
    expect((await call("POST", `${path}/schedule`, { send_at: later })).body.draft.schedule.send_at).toBe(later);
    expect((await call("DELETE", `${path}/schedule`)).body.draft).toMatchObject({ body_html: reply.body_html, schedule: null });
    await call("POST", `${path}/schedule`, { send_at: at, reply });
    expect((await call("POST", `${path}/send`)).status).toBe(201);
    expect((await call("POST", `${path}/send`)).status).toBe(404);
    expect((await call("GET", path)).body.draft).toBeNull();
  });

});
