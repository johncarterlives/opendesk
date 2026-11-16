import { describe, expect, it } from "vitest";
import type { MailSource, Message } from "@/lib/api/types";
import { db } from "../db";
import { installMock } from "../index";
import { dispatch } from "../router";

async function call(path: string) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method: "GET", headers: ws ? { "OD-Workspace": ws } : {} });
  return r;
}

describe("mock message source", () => {
  installMock();

  it("shows the raw email of a customer's message and saves it as a file, and nothing for a reply of ours", async () => {
    const ws = db.workspaces[0]!;
    const email = ws.messages.find((m: Message) => m.direction === "inbound" && m.kind === "reply" && m.mailbox_id && !m.deleted_at)!;
    const src = (await (await call(`/v1/messages/${email.id}/source`)).json()) as MailSource;
    expect(src.source).toContain("Authentication-Results:");
    expect(src.source).toContain(`Message-ID: <${email.id}@mail.example.net>`);
    expect(src.source.split("\r\n\r\n")).toHaveLength(2);
    expect(src.truncated).toBe(false);
    const file = await call(`/v1/messages/${email.id}/source.eml`);
    expect(file.headers.get("content-type")).toBe("message/rfc822");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.eml"$/);
    expect(await file.text()).toBe(src.source);
    const ours = ws.messages.find((m: Message) => m.direction === "outbound" && m.kind === "reply")!;
    expect((await call(`/v1/messages/${ours.id}/source`)).status).toBe(404);
  });

  it("shows a Collab message's source", async () => {
    const list = (await (await call("/v1/collab/threads?limit=5")).json()) as { data: { id: string }[] };
    const detail = (await (await call(`/v1/collab/threads/${list.data[0]!.id}`)).json()) as { messages: { id: string; subject: string }[] };
    const id = detail.messages[0]!.id;
    const src = (await (await call(`/v1/collab/messages/${id}/source`)).json()) as MailSource;
    expect(src.source).toContain(`Subject: ${detail.messages[0]!.subject}`);
    expect((await call(`/v1/collab/messages/${id}/source.eml`)).headers.get("content-type")).toBe("message/rfc822");
  });
});
