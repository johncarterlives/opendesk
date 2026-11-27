import { describe, expect, it } from "vitest";
import { installMock } from "@/mock/index";
import { dispatch } from "@/mock/router";
import { db } from "@/mock/db";
import type { MailThread, MailThreadDetail, Message, Ticket } from "@/lib/api/types";
import { mailThreadPrompt, ticketMessagePrompt, ticketPrompt } from "./agentPrompt";

async function get<T>(path: string): Promise<T> {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method: "GET", headers: ws ? { "OD-Workspace": ws } : {} });
  expect(r.status).toBe(200);
  return (await r.json()) as T;
}
const rows = <T>(b: T[] | { data: T[] }) => (Array.isArray(b) ? b : b.data);

// Mock mode (VITE_MOCK=1) answers every route the copy reads.
describe("copy for AI agent in mock mode", () => {
  installMock();

  it("copies a seeded ticket, one of its messages in full, and a Collab conversation", async () => {
    const tickets = rows(await get<{ data: Ticket[] }>("/v1/tickets"));
    let found: { t: Ticket; messages: Message[] } | null = null;
    for (const t of tickets) {
      const messages = rows(await get<Message[] | { data: Message[] }>(`/v1/tickets/${t.id}/messages`));
      if (messages.some((m) => m.kind === "note") && messages.some((m) => m.direction === "inbound")) {
        found = { t, messages };
        break;
      }
    }
    expect(found).not.toBeNull();
    const { t, messages } = found!;
    const whole = ticketPrompt(t, messages, { origin: "http://localhost" });
    expect(whole).toContain(`## Ticket #${t.number}`);
    expect(whole).toContain("Internal note (only the team sees it)");
    expect(whole).not.toContain("sig=");

    const inbound = messages.find((m) => m.direction === "inbound" && m.kind === "reply")!;
    const { full_html } = await get<{ full_html: string }>(`/v1/messages/${inbound.id}/original`);
    const one = ticketMessagePrompt(t, inbound, { origin: "http://localhost", fullHtml: full_html });
    expect(one).toContain("## Message");
    expect(one).not.toContain("Internal note");

    const threads = rows(await get<{ data: MailThread[] }>("/v1/collab/threads?box=all"));
    expect(threads.length).toBeGreaterThan(0);
    const detail = await get<MailThreadDetail>(`/v1/collab/threads/${threads[0].id}`);
    const mail = mailThreadPrompt(detail, "http://localhost");
    expect(mail).toContain(`- Link: http://localhost/mail/all/${detail.thread.id}`);
    expect(mail).toMatch(/### 1\. Email (received|sent from this account)/);
  });
});
