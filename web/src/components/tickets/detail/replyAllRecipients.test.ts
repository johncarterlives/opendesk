import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/api/types";
import { addReplyAll, inboundRecipients, latestInbound, ownAddresses, removeReplyAll, replyAllExtras, replyAllOn } from "./replyAllRecipients";

let n = 0;
function msg(p: Partial<Message> = {}): Message {
  n++;
  return {
    id: `m${n}`,
    ticket_id: "t1",
    kind: "reply",
    direction: "inbound",
    from_email: "sales@supplier.test",
    reply_to: "",
    to: ["info@example-desk.test"],
    cc: [],
    bcc: [],
    created_at: new Date(2026, 10, 10, 9, n).toISOString(),
    ...p,
  } as Message;
}

// A supplier wrote to us and to their local agent (two addresses of the agent's).
const withAgent = msg({ to: ["bart@agent.test", "info@agent.test", "info@example-desk.test"] });
const own = ownAddresses(
  [
    { email: "info@example-desk.test", aliases: [] },
    { email: "support@example-desk.test", aliases: ["help@example-desk.test"] },
  ],
  "Nora@Example-desk.test",
);

describe("ownAddresses", () => {
  it("has every mailbox's address and aliases, and the writer's, in lower case", () => {
    expect([...own].sort()).toEqual(["help@example-desk.test", "info@example-desk.test", "nora@example-desk.test", "support@example-desk.test"]);
    expect(ownAddresses(undefined, null).size).toBe(0);
  });
  it("has each mailbox's forwarding address too, so Reply all never Cc's where our own mail arrives", () => {
    const fwd = ownAddresses([
      { email: "support@example-desk.test", aliases: [], forwarding_address: "Support-x1@Inbound.opendesk.test" },
      { email: "info@example-desk.test", aliases: [], forwarding_address: "" },
    ]);
    expect([...fwd].sort()).toEqual(["info@example-desk.test", "support-x1@inbound.opendesk.test", "support@example-desk.test"]);
    const m = msg({ to: ["support-x1@inbound.opendesk.test", "bart@agent.test"] });
    expect(replyAllExtras(m, { own: fwd, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual(["bart@agent.test"]);
  });
});

describe("latestInbound", () => {
  it("takes the customer's latest email, past our replies, notes, side conversations, deleted and held copies", () => {
    const a = msg();
    const list = [
      msg(),
      a,
      msg({ direction: "outbound" }),
      msg({ kind: "note" }),
      msg({ thread_id: "th1" }),
      msg({ deleted_at: "2026-11-10T10:00:00Z" }),
      msg({ id: "tmp-x" }),
    ];
    expect(latestInbound(list)?.id).toBe(a.id);
    expect(latestInbound([msg({ direction: "outbound" })])).toBeUndefined();
    expect(latestInbound(undefined)).toBeUndefined();
  });
  it("passes over an email that failed sender authentication, as the server's reply recipient does", () => {
    const ok = msg();
    const spoofed = msg({ auth_failed: true, cc: ["someone@elsewhere.test"] });
    expect(latestInbound([ok, spoofed])?.id).toBe(ok.id);
    expect(latestInbound([spoofed])).toBeUndefined();
  });
});

describe("replyAllExtras", () => {
  it("adds the other recipients, without our addresses or the contact's", () => {
    expect(replyAllExtras(withAgent, { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual(["bart@agent.test", "info@agent.test"]);
  });
  it("reads Cc too, dedupes case-insensitively and skips our aliases, the writer and what the reply already reaches", () => {
    const m = msg({
      to: ["support@example-desk.test", "Bart@Agent.test"],
      cc: ["bart@agent.test", "HELP@example-desk.test", "nora@example-desk.test", "ana@client.test", "boss@client.test", "not an address"],
    });
    expect(replyAllExtras(m, { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test", "ana@client.test"], bcc: ["boss@client.test"] })).toEqual([
      "Bart@Agent.test",
    ]);
  });
  it("adds the sender (where the server says replies go) when it is not the contact", () => {
    const m = msg({ from_email: "colleague@supplier.test", to: ["info@example-desk.test"] });
    expect(replyAllExtras(m, { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual(["colleague@supplier.test"]);
    // A Reply-To at the sender's own organisation: the server's reply_address.
    const r = msg({ from_email: "sales@supplier.test", reply_to: "orders@supplier.test", reply_address: "orders@supplier.test", to: ["info@example-desk.test"] });
    expect(replyAllExtras(r, { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual(["orders@supplier.test"]);
  });
  it("never adds a Reply-To at another organisation: the server leaves reply_address empty and the sender stays", () => {
    const r = msg({ from_email: "colleague@supplier.test", reply_to: "collect@elsewhere.test", reply_address: "", to: ["info@example-desk.test"] });
    expect(replyAllExtras(r, { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual(["colleague@supplier.test"]);
  });
  it("adds nobody from an email that failed sender authentication", () => {
    const m = msg({ auth_failed: true, from_email: "colleague@supplier.test", cc: ["bart@agent.test"] });
    expect(replyAllExtras(m, { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual([]);
  });
  it("is empty when nobody else was on the email", () => {
    expect(replyAllExtras(msg(), { own, contactEmail: "sales@supplier.test", to: ["sales@supplier.test"] })).toEqual([]);
    expect(replyAllExtras(undefined, { own })).toEqual([]);
  });
  it("follows the To the agent chose for this reply (the To row)", () => {
    // The reply goes to the agent instead of the supplier: the supplier comes in Cc.
    expect(replyAllExtras(withAgent, { own, contactEmail: "sales@supplier.test", to: ["bart@agent.test"] })).toEqual(["info@agent.test"]);
  });
});

describe("Reply all and back", () => {
  it("adds only what the Cc lacks, and Reply takes out exactly that, keeping what the agent typed", () => {
    const typed = ["ana@client.test", "INFO@agent.test"];
    const on = addReplyAll(typed, ["bart@agent.test", "info@agent.test"]);
    expect(on).toEqual({ cc: ["ana@client.test", "INFO@agent.test", "bart@agent.test"], added: ["bart@agent.test"] });
    expect(replyAllOn(on.cc, on.added)).toBe(true);
    expect(removeReplyAll([...on.cc, "later@client.test"], on.added)).toEqual(["ana@client.test", "INFO@agent.test", "later@client.test"]);
  });
  it("is off when nothing it added is left in the Cc (after sending, or the agent removed them)", () => {
    expect(replyAllOn([], ["bart@agent.test"])).toBe(false);
    expect(replyAllOn(["ana@client.test"], ["bart@agent.test"])).toBe(false);
    expect(replyAllOn(["ana@client.test"], undefined)).toBe(false);
    expect(replyAllOn(["Bart@agent.test"], ["bart@agent.test"])).toBe(true);
  });
});

describe("inboundRecipients", () => {
  it("lists To and Cc when the email had more than one recipient", () => {
    expect(inboundRecipients(withAgent)).toEqual({ to: withAgent.to, cc: [] });
    expect(inboundRecipients(msg({ cc: ["bart@agent.test"] }))).toEqual({ to: ["info@example-desk.test"], cc: ["bart@agent.test"] });
    expect(inboundRecipients(msg({ to: [], cc: ["a@x.test", "b@x.test"] }))).toEqual({ to: [], cc: ["a@x.test", "b@x.test"] });
  });
  it("keeps the short header for an email to us alone", () => {
    expect(inboundRecipients(msg())).toBeNull();
    expect(inboundRecipients(msg({ to: [] }))).toBeNull();
  });
});
