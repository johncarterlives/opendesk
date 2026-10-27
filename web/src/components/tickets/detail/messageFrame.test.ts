import { describe, expect, it } from "vitest";
import type { ContactRef, Message, UserRef } from "@/lib/api/types";
import { messageAuthor, messageFrame } from "./messageFrame";

type Shape = Pick<Message, "kind" | "direction" | "author" | "thread_id">;

const user: UserRef = { id: "u1", name: "Maya Chen", email: "maya@example.com", avatar_url: null };
const contact: ContactRef = { id: "c1", name: "Dana", email: "dana@example.com", avatar_url: null };

function msg(over: Partial<Shape> & { type?: Message["author"]["type"] } = {}): Shape {
  const { type = "contact", ...rest } = over;
  return {
    kind: "reply",
    direction: "inbound",
    thread_id: null,
    author: { type, user: type === "user" ? user : null, contact: type === "contact" ? contact : null },
    ...rest,
  };
}

describe("messageAuthor", () => {
  it("reads a contact's inbound message as the customer's", () => {
    expect(messageAuthor(msg())).toBe("customer");
    expect(messageAuthor(msg({ type: "api" }))).toBe("customer");
  });
  it("reads every outbound reply as the team's: agents, the AI agent, automations and the API", () => {
    expect(messageAuthor(msg({ type: "user", direction: "outbound" }))).toBe("team");
    expect(messageAuthor(msg({ type: "system", direction: "outbound" }))).toBe("team");
    expect(messageAuthor(msg({ type: "api", direction: "outbound" }))).toBe("team");
  });
  it("reads a message a member wrote as the team's", () => {
    expect(messageAuthor(msg({ type: "user" }))).toBe("team");
  });
  it("reads a note as a note, whoever wrote it", () => {
    expect(messageAuthor(msg({ type: "user", kind: "note", direction: "outbound" }))).toBe("note");
    expect(messageAuthor(msg({ type: "system", kind: "note", direction: "outbound" }))).toBe("note");
  });
  it("reads a side conversation message as the thread's, both ways", () => {
    expect(messageAuthor(msg({ type: "user", kind: "note", direction: "outbound", thread_id: "th1" }))).toBe("thread");
    expect(messageAuthor(msg({ kind: "note", thread_id: "th1" }))).toBe("thread");
  });
});

describe("messageFrame", () => {
  it("gives each author its own surface and border", () => {
    expect(messageFrame("customer", false)).toBe("border-line bg-surface");
    expect(messageFrame("team", false)).toBe("border-reply-line bg-reply");
    expect(messageFrame("note", false)).toBe("border-dashed border-note-line bg-note");
  });
  it("keeps the three apart", () => {
    const frames = new Set((["customer", "team", "note"] as const).map((a) => messageFrame(a, false)));
    expect(frames.size).toBe(3);
  });
  it("marks a failed delivery in red and keeps the team's surface", () => {
    const f = messageFrame("team", true);
    expect(f).toContain("border-tone-red-line");
    expect(f).toContain("bg-reply");
    expect(f).not.toContain("border-reply-line");
  });
  it("frames a side conversation in cyan", () => {
    expect(messageFrame("thread", false)).toContain("border-tone-cyan-line");
    expect(messageFrame("thread", false)).toContain("bg-surface");
  });
  it("never lets a note look failed", () => {
    expect(messageFrame("note", true)).toBe("border-dashed border-note-line bg-note");
  });
});
