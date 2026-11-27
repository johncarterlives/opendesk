import { afterEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@/lib/api/types";
import { createTicketBody, draftKey, emptyNewTicket, isDirty, newTicketDrafts, newTicketProblem, pageOnlyCount, type NewTicketDraft } from "./newTicket";

const contact = { id: "c1", name: "Ada Lovelace", email: "ada@example.com" } as Contact;
const draft = (over: Partial<NewTicketDraft> = {}): NewTicketDraft => ({ ...emptyNewTicket, ...over });
// What goes over the wire: keys left undefined are not sent.
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));
const mine = draftKey("u1", "w1");
const otherWorkspace = draftKey("u1", "w2");
const otherPerson = draftKey("u2", "w1");

describe("the new ticket draft", () => {
  afterEach(() => [mine, otherWorkspace, otherPerson].forEach(newTicketDrafts.clear));

  it("hands what the dialog wrote to the page as is", () => {
    newTicketDrafts.patch(mine, { to: { contact }, subject: "Lamp flickers" });
    newTicketDrafts.patch(mine, { body: "<p>Hello</p>", kind: "note", priority: "high", assignee: null, team: "t1", mailbox: "m1" });
    // The page reads the same draft the dialog left.
    expect(newTicketDrafts.get(mine)).toEqual(
      draft({ to: { contact }, subject: "Lamp flickers", body: "<p>Hello</p>", kind: "note", priority: "high", assignee: null, team: "t1", mailbox: "m1" }),
    );
    // One draft per person and workspace: another account on this browser never gets it.
    expect(newTicketDrafts.get(otherWorkspace)).toEqual(emptyNewTicket);
    expect(newTicketDrafts.get(otherPerson)).toEqual(emptyNewTicket);
  });

  it("starts over once discarded or created", () => {
    newTicketDrafts.patch(mine, { subject: "Lamp flickers", tags: ["bug"] });
    newTicketDrafts.patch(otherWorkspace, { subject: "Other workspace" });
    newTicketDrafts.clear(mine);
    expect(newTicketDrafts.get(mine)).toEqual(emptyNewTicket);
    expect(newTicketDrafts.get(otherWorkspace).subject).toBe("Other workspace");
  });

  it("counts what was written, not the defaults picked for it", () => {
    expect(isDirty(draft({ mailbox: "m1", priority: "high", assignee: null, team: null, kind: "note", showCc: true }))).toBe(false);
    expect(isDirty(draft({ to: { email: "ada@example.com" } }))).toBe(true);
    expect(isDirty(draft({ subject: "x" }))).toBe(true);
    expect(isDirty(draft({ body: "<p>x</p>" }))).toBe(true);
    expect(isDirty(draft({ tags: ["bug"] }))).toBe(true);
    expect(isDirty(draft({ fields: { plan: "pro" } }))).toBe(true);
    expect(isDirty(draft({ cc: ["b@example.com"] }))).toBe(true);
  });

  it("counts what only the full page shows, for the dialog to say it goes along", () => {
    expect(pageOnlyCount(draft({ to: { contact }, subject: "x", body: "y", priority: "high", team: "t1", assignee: null }))).toBe(0);
    // The dialog shows Cc and Bcc itself.
    expect(pageOnlyCount(draft({ tags: ["bug", "hardware"], severity: "sev2", fields: { plan: "pro" }, cc: ["b@example.com"], bcc: ["c@example.com"] }))).toBe(4);
  });

  it("comes back after a reload, until it is sent, discarded or its person signs out", async () => {
    newTicketDrafts.patch(mine, { to: { contact }, moreTo: [{ email: "deputy@example.com" }], subject: "Lamp flickers", cc: ["b@example.com"] });
    newTicketDrafts.patch(otherPerson, { subject: "Someone else's" });
    const kept = JSON.parse(localStorage.getItem(`od:new-ticket:${mine}`)!);
    expect(kept).toMatchObject({ subject: "Lamp flickers", moreTo: [{ email: "deputy@example.com" }], cc: ["b@example.com"] });
    // A fresh page load reads it back.
    vi.resetModules();
    const fresh = await import("./newTicket");
    expect(fresh.newTicketDrafts.get(mine)).toMatchObject({ subject: "Lamp flickers", to: { contact }, moreTo: [{ email: "deputy@example.com" }] });
    // Defaults alone are not kept, and a broken entry is ignored.
    fresh.newTicketDrafts.patch(otherWorkspace, { mailbox: "m1" });
    expect(localStorage.getItem(`od:new-ticket:${otherWorkspace}`)).toBeNull();
    localStorage.setItem(`od:new-ticket:${draftKey("u3", "w1")}`, "{not json");
    expect(fresh.newTicketDrafts.get(draftKey("u3", "w1"))).toEqual(emptyNewTicket);
    // Signing out takes the person's drafts with them, not another's.
    fresh.newTicketDrafts.forget("u1");
    expect(localStorage.getItem(`od:new-ticket:${mine}`)).toBeNull();
    expect(fresh.newTicketDrafts.get(mine)).toEqual(emptyNewTicket);
    expect(localStorage.getItem(`od:new-ticket:${otherPerson}`)).not.toBeNull();
    fresh.newTicketDrafts.clear(otherPerson);
    expect(localStorage.getItem(`od:new-ticket:${otherPerson}`)).toBeNull();
    localStorage.clear();
  });

  it("asks for a recipient, a subject, a message, then an address that can send", () => {
    expect(newTicketProblem(draft(), false)).toBe("needTo");
    expect(newTicketProblem(draft({ to: { contact }, subject: "  " }), false)).toBe("needSubject");
    expect(newTicketProblem(draft({ to: { contact }, subject: "Hi" }), false)).toBe("needBody");
    expect(newTicketProblem(draft({ to: { contact }, subject: "Hi", body: "<p>x</p>" }), true)).toBe("cannotSend");
    expect(newTicketProblem(draft({ to: { contact }, subject: "Hi", body: "<p>x</p>" }), false)).toBeNull();
  });
});

describe("createTicketBody", () => {
  const o = { me: "u-me", teamId: "t1", hasTeams: true };

  it("sends what the dialog sends: an email to a contact, from the address, assigned to me", () => {
    const d = draft({ to: { contact }, subject: "  Lamp flickers ", body: "<p>Hello</p>", mailbox: "m1" });
    expect(wire(createTicketBody(d, o))).toEqual({
      subject: "Lamp flickers",
      contact_id: "c1",
      channel: "email",
      mailbox_id: "m1",
      body_html: "<p>Hello</p>",
      kind: "reply",
      priority: "normal",
      assignee_id: "u-me",
      team_id: "t1",
      status: "pending",
    });
  });

  it("creates the contact from a typed address, and logs a note open with no address", () => {
    const d = draft({ to: { email: "new@example.com" }, subject: "Call notes", body: "<p>x</p>", kind: "note", assignee: null, priority: "low" });
    expect(wire(createTicketBody(d, { ...o, teamId: null }))).toEqual({
      subject: "Call notes",
      contact: { email: "new@example.com", name: "" },
      channel: "api",
      body_html: "<p>x</p>",
      kind: "note",
      priority: "low",
      status: "open",
    });
  });

  it("leaves the team out where the workspace has no teams", () => {
    expect(createTicketBody(draft({ to: { contact }, subject: "x", body: "y" }), { ...o, hasTeams: false }).team_id).toBeUndefined();
  });

  it("adds the page's labels, severity, fields, copies and files in the same request", () => {
    const d = draft({
      to: { contact },
      subject: "Lamp flickers",
      body: "<p>Hello</p>",
      mailbox: "m1",
      assignee: "u-2",
      severity: "sev2",
      tags: ["bug", "hardware"],
      fields: { plan: "pro" },
      cc: ["b@example.com"],
      bcc: ["c@example.com"],
    });
    expect(wire(createTicketBody(d, { ...o, attachmentIds: ["a1", "a2"] }))).toEqual({
      subject: "Lamp flickers",
      contact_id: "c1",
      channel: "email",
      mailbox_id: "m1",
      body_html: "<p>Hello</p>",
      kind: "reply",
      priority: "normal",
      severity: "sev2",
      assignee_id: "u-2",
      team_id: "t1",
      tags: ["bug", "hardware"],
      fields: { plan: "pro" },
      cc: ["b@example.com"],
      bcc: ["c@example.com"],
      attachment_ids: ["a1", "a2"],
      status: "pending",
    });
  });

  it("sends the first email to the contact and everyone added after it", () => {
    const d = draft({ to: { contact }, moreTo: [{ contact: { ...contact, id: "c2", email: "bob@example.com" } }, { email: "deputy@example.com" }], subject: "x", body: "y", mailbox: "m1" });
    expect(wire(createTicketBody(d, o))).toMatchObject({ contact_id: "c1", to: [{ contact_id: "c2" }, { email: "deputy@example.com" }] });
    expect(isDirty(draft({ moreTo: [{ email: "deputy@example.com" }] }))).toBe(true);
    // A note, a logged request and a chat go to the contact alone.
    expect(createTicketBody({ ...d, kind: "note" }, o)).not.toHaveProperty("to");
    expect(createTicketBody({ ...d, channel: "log" }, o)).not.toHaveProperty("to");
    expect(createTicketBody({ ...d, channel: "chat" }, o)).not.toHaveProperty("to");
  });

  it("sends copies only with an emailed reply", () => {
    const d = draft({ to: { contact }, subject: "x", body: "y", mailbox: "m1", cc: ["b@example.com"], bcc: ["c@example.com"] });
    expect(createTicketBody({ ...d, kind: "note" }, o)).not.toHaveProperty("cc");
    expect(createTicketBody({ ...d, mailbox: undefined }, o)).not.toHaveProperty("bcc");
  });

  it("logs a request as the customer's own message on an email ticket, and emails nothing", () => {
    const log = draft({ kind: "reply", channel: "log", to: { contact }, subject: "Phone call", body: "<p>Printer is down</p>", mailbox: "m1", cc: ["b@example.com"] });
    // It needs a recipient, a subject and a message, but never an address that can send now.
    expect(newTicketProblem(log, true)).toBeNull();
    expect(newTicketProblem({ ...log, subject: " " }, false)).toBe("needSubject");
    expect(newTicketProblem({ ...log, body: "" }, false)).toBe("needBody");
    // Inbound, so it is stored as the customer's and sent to no one; the address stays, so the
    // team's replies go by email; no copies; open, since the team still has to answer it.
    expect(wire(createTicketBody(log, o))).toEqual({
      subject: "Phone call",
      contact_id: "c1",
      channel: "email",
      mailbox_id: "m1",
      body_html: "<p>Printer is down</p>",
      kind: "reply",
      direction: "inbound",
      priority: "normal",
      assignee_id: "u-me",
      team_id: "t1",
      status: "open",
    });
    // A workspace without an address logs it on an api ticket.
    expect(createTicketBody({ ...log, mailbox: undefined }, o)).toMatchObject({ channel: "api", direction: "inbound", status: "open" });
    // The same draft by email is sent from the address, as the team's.
    const emailed = createTicketBody({ ...log, channel: "email" }, o);
    expect(emailed).toMatchObject({ channel: "email", mailbox_id: "m1", cc: ["b@example.com"], status: "pending" });
    expect(emailed).not.toHaveProperty("direction");
  });

  it("opens a chat only with a contact on chat, without email's address and copies", () => {
    const onChat = { ...contact, chat_reachable: true } as Contact;
    const chat = draft({ kind: "reply", channel: "chat", to: { contact }, body: "<p>Hi</p>", mailbox: "m1", cc: ["b@example.com"] });
    expect(newTicketProblem(chat, false)).toBe("notOnChat");
    expect(newTicketProblem({ ...chat, to: { email: "x@example.com" } }, false)).toBe("notOnChat");
    // No subject needed: the chat is named after its first message.
    expect(newTicketProblem({ ...chat, to: { contact: onChat } }, true)).toBeNull();
    expect(newTicketProblem({ ...chat, to: { contact: onChat }, body: "" }, false)).toBe("needBody");
    expect(wire(createTicketBody({ ...chat, to: { contact: onChat }, widgetId: "w1" }, o))).toEqual({
      subject: "",
      contact_id: "c1",
      channel: "chat",
      widget_id: "w1",
      body_html: "<p>Hi</p>",
      kind: "reply",
      priority: "normal",
      assignee_id: "u-me",
      team_id: "t1",
      status: "pending",
    });
    // An internal note stays a note whatever the channel last picked.
    expect(createTicketBody({ ...chat, kind: "note" }, o).channel).not.toBe("chat");
  });
});
