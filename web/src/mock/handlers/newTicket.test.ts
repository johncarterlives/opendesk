import { describe, expect, it } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";
import type { Contact, Mailbox, Message, Ticket } from "@/lib/api/types";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: ws ? { "OD-Workspace": ws } : {},
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock new ticket", () => {
  installMock();

  it("creates the page's ticket in one request: labels, copies and files on the first message", async () => {
    const contact = ((await call("GET", "/v1/contacts?limit=5")).body.data as Contact[]).find((c) => c.email)!;
    const box = ((await call("GET", "/v1/mailboxes")).body.data as Mailbox[]).find((m) => m.status === "active" && m.sending !== "system_off")!;
    db.attachments.push({ id: "att-new-ticket", filename: "invoice.pdf", content_type: "application/pdf", size_bytes: 1200, inline: false, url: "https://example.com/invoice.pdf" });
    const created = await call("POST", "/v1/tickets", {
      subject: "Lamp flickers",
      contact_id: contact.id,
      channel: "email",
      mailbox_id: box.id,
      body_html: "<p>Hello</p>",
      kind: "reply",
      priority: "high",
      tags: ["bug"],
      cc: ["copy@example.com"],
      bcc: ["hidden@example.com"],
      attachment_ids: ["att-new-ticket"],
      status: "pending",
    });
    expect(created.status).toBe(201);
    const t = created.body as Ticket;
    // An existing label matches whatever its case.
    expect(t.tags.map((x) => x.name.toLowerCase())).toContain("bug");
    const msgs = (await call("GET", `/v1/tickets/${t.id}/messages`)).body.data as Message[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "reply", cc: ["copy@example.com"], bcc: ["hidden@example.com"] });
    expect(msgs[0].attachments.map((a) => a.filename)).toEqual(["invoice.pdf"]);
  });

  it("sends the first email to the contact and everyone else in To, refusing a contact of nowhere", async () => {
    const contacts = ((await call("GET", "/v1/contacts?limit=10")).body.data as Contact[]).filter((c) => c.email);
    const [first, second] = contacts;
    const box = ((await call("GET", "/v1/mailboxes")).body.data as Mailbox[]).find((m) => m.status === "active" && m.sending !== "system_off")!;
    const base = { subject: "Two people", contact_id: first!.id, channel: "email", mailbox_id: box.id, body_html: "<p>Hello both</p>", kind: "reply" };
    const created = await call("POST", "/v1/tickets", { ...base, to: [{ contact_id: second!.id }, { email: "Third@Example.com" }, { email: first!.email }] });
    expect(created.status).toBe(201);
    const t = created.body as Ticket;
    expect(t.contact?.id).toBe(first!.id);
    const msgs = (await call("GET", `/v1/tickets/${t.id}/messages`)).body.data as Message[];
    expect(msgs[0]!.to).toEqual([first!.email, second!.email!.toLowerCase(), "third@example.com"]);
    expect((await call("POST", "/v1/tickets", { ...base, to: [{ contact_id: "nope" }] })).status).toBe(422);
    expect((await call("POST", "/v1/tickets", { ...base, to: [{ email: "not an address" }] })).status).toBe(422);
    expect((await call("POST", "/v1/tickets", { ...base, kind: "note", to: [{ email: "x@example.com" }] })).status).toBe(422);
  });

  it("logs a customer's request as their own message on the email ticket, sending nothing", async () => {
    const contact = ((await call("GET", "/v1/contacts?limit=5")).body.data as Contact[]).find((c) => c.email)!;
    const box = ((await call("GET", "/v1/mailboxes")).body.data as Mailbox[]).find((m) => m.status === "active" && m.sending !== "system_off")!;
    const req = { subject: "Phone call", contact_id: contact.id, channel: "email", mailbox_id: box.id, body_html: "<p>Printer is down</p>", kind: "reply", direction: "inbound", status: "open" };
    const created = await call("POST", "/v1/tickets", req);
    expect(created.status).toBe(201);
    const t = created.body as Ticket;
    expect(t).toMatchObject({ channel: "email", mailbox_id: box.id, status: "open", first_responded_at: null });
    expect(t.waiting_since).toBeTruthy();
    const msgs = (await call("GET", `/v1/tickets/${t.id}/messages`)).body.data as Message[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "reply", direction: "inbound", delivery_status: "none" });
    expect(msgs[0].author.type).toBe("contact");
    // A note, copies, or no contact: refused, as by the API.
    expect((await call("POST", "/v1/tickets", { ...req, kind: "note" })).status).toBe(422);
    expect((await call("POST", "/v1/tickets", { ...req, cc: ["copy@example.com"] })).status).toBe(422);
    expect((await call("POST", "/v1/tickets", { ...req, contact_id: undefined })).status).toBe(422);
  });

  it("keeps copies off a ticket that starts as a note", async () => {
    const contact = ((await call("GET", "/v1/contacts?limit=5")).body.data as Contact[]).find((c) => c.email)!;
    const created = await call("POST", "/v1/tickets", { subject: "Call notes", contact_id: contact.id, channel: "api", body_html: "<p>x</p>", kind: "note", cc: ["copy@example.com"], status: "open" });
    expect(created.status).toBe(201);
    const msgs = (await call("GET", `/v1/tickets/${created.body.id}/messages`)).body.data as Message[];
    expect(msgs[0]).toMatchObject({ kind: "note", cc: [] });
  });

  it("starts a chat only with a contact the widget knows, named after its first message", async () => {
    const contacts = (await call("GET", "/v1/contacts?limit=100")).body.data as Contact[];
    const onChat = contacts.find((c) => c.chat_reachable)!;
    const offChat = contacts.find((c) => !c.chat_reachable && !c.blocked)!;
    const refused = await call("POST", "/v1/tickets", { subject: "", contact_id: offChat.id, channel: "chat", body_html: "<p>Hi</p>", kind: "reply" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("chat_unreachable");
    const created = await call("POST", "/v1/tickets", { subject: "", contact_id: onChat.id, channel: "chat", body_html: "<p>Your order shipped</p>", kind: "reply", status: "pending" });
    expect(created.status).toBe(201);
    const t = created.body as Ticket;
    expect(t).toMatchObject({ channel: "chat", subject: "Your order shipped", mailbox_id: null, visitor_read_at: null });
    expect(t.widget_id).toBeTruthy();
    const msgs = (await call("GET", `/v1/tickets/${t.id}/messages`)).body.data as Message[];
    expect(msgs[0]).toMatchObject({ kind: "reply", direction: "outbound" });
  });
});
