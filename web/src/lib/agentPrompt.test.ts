import { describe, expect, it } from "vitest";
import type { MailMessage, MailThreadDetail, Message } from "@/lib/api/types";
import { ticket } from "@/lib/test/fixtures";
import { mailThreadPrompt, PROMPT_BODY_MAX, PROMPT_MAX, ticketMessagePrompt, ticketPrompt } from "./agentPrompt";

const ORIGIN = "https://app.example.com";
const SIGNED = "https://api.example.com/v1/attachments/a1?exp=1700000000&sig=secret-signature";

let n = 0;
function msg(over: Partial<Message> = {}): Message {
  n++;
  return {
    id: `m${n}`,
    ticket_id: "t1",
    kind: "reply",
    direction: "inbound",
    author: { type: "contact", user: null, contact: { id: "c1", name: "Dana Diaz", email: "dana@example.com", avatar_url: null } },
    body_html: "<p>Hi</p>",
    body_text: "Hi",
    has_quoted: false,
    subject: "",
    from_email: "dana@example.com",
    from_name: "Dana Diaz",
    to: ["support@example.com"],
    cc: [],
    bcc: [],
    attachments: [],
    delivery_status: "none",
    delivery_error: "",
    ai: false,
    thread_id: null,
    created_at: new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString(),
    edited_at: null,
    ...over,
  };
}

const maya = { type: "user" as const, user: { id: "u1", name: "Maya", email: "maya@example.com", avatar_url: null }, contact: null };
const t = ticket({
  id: "t1",
  number: 42,
  subject: "Export crashes",
  status: "pending",
  contact: { id: "c1", name: "Dana Diaz", email: "dana@example.com", avatar_url: null },
});
const ctx = { origin: ORIGIN, mailbox: { name: "Support", email: "support@example.com" } };

describe("ticketPrompt", () => {
  const bug = msg({
    body_html: '<p>Export <strong>crashes</strong> on step 2:</p><ol><li>Open reports</li><li>Click export</li></ol><p><img src="https://api.example.com/v1/attachments/a2?exp=1&sig=x"></p>',
    attachments: [
      { id: "a1", filename: "log.txt", content_type: "text/plain", size_bytes: 2048, inline: false, url: SIGNED },
      { id: "a2", filename: "screen.png", content_type: "image/png", size_bytes: 3 * 1024 * 1024, inline: true, url: "https://api.example.com/v1/attachments/a2?exp=1&sig=x" },
    ],
  });
  const reply = msg({ direction: "outbound", author: maya, from_email: "support@example.com", from_name: "Support", to: ["dana@example.com"], cc: ["lee@example.com"], body_html: "<p>Looking into it.</p>", has_quoted: true });
  const note = msg({ kind: "note", direction: "outbound", author: maya, body_html: "<p>Repro on staging.</p>" });
  const side = msg({ kind: "note", direction: "outbound", author: maya, thread_id: "th1", to: ["vendor@example.com"], body_html: "<p>Seen this?</p>" });
  const deleted = msg({ deleted_at: "2026-10-02T00:00:00Z", body_html: "<p>gone</p>" });
  const held = msg({ direction: "outbound", author: maya, delivery_status: "scheduled", body_html: "<p>not sent yet</p>" });
  const sending = msg({ id: "tmp-1", direction: "outbound", author: maya, body_html: "<p>sending</p>" });
  const out = ticketPrompt(t, [reply, bug, note, side, deleted, held, sending], ctx);

  it("starts with what to do and the ticket's facts and link", () => {
    expect(out.split("\n")[0]).toMatch(/^Below is a support conversation from opendesk/);
    expect(out).toContain("## Ticket #42");
    expect(out).toContain("- Subject: Export crashes");
    expect(out).toContain("- Status: Pending");
    expect(out).toContain("- Channel: Email");
    expect(out).toContain("- Mailbox: Support <support@example.com>");
    expect(out).toContain("- Customer: Dana Diaz <dana@example.com>");
    expect(out).toContain(`- Link: ${ORIGIN}/inbox/open/t1`);
  });

  it("lists the messages oldest first, labelled, with their headers and markdown bodies", () => {
    expect(out).toContain("## Messages, oldest first (4)");
    const order = ["1. Customer email", "2. Team email reply", "3. Internal note (only the team sees it)", "4. Side conversation message"];
    const at = order.map((h) => out.indexOf(`### ${h}`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out).toContain("- From: Dana Diaz <dana@example.com>\n- To: support@example.com\n- Date: 2026-10-01 09:");
    expect(out).toContain("- From: Maya <support@example.com>\n- To: dana@example.com\n- Cc: lee@example.com");
    expect(out).toContain("Export **crashes** on step 2:\n\n1. Open reports\n2. Click export\n\n[image: screen.png]");
    expect(out).toContain("[The earlier conversation this message quoted is left out. Open the link for it.]");
    expect(out).toContain("Repro on staging.");
  });

  it("lists files by name, type and size, never their signed links", () => {
    expect(out).toContain("- Attachments: log.txt (text/plain, 2 KB)");
    expect(out).toContain("- Inline images: screen.png (image/png, 3.0 MB)");
    expect(out).toContain("Attachments are listed by name only. Open the link to see or download them.");
    expect(out).not.toContain("sig=");
    expect(out).not.toContain("/v1/attachments/");
  });

  it("leaves out deleted messages, held replies and ones still sending", () => {
    expect(out).not.toContain("gone");
    expect(out).not.toContain("not sent yet");
    expect(out).not.toContain("sending");
  });

  it("keeps the first message and the newest that fit when the ticket is long", () => {
    const big = Array.from({ length: 40 }, (_, i) => msg({ body_html: `<p>${`m${i} `.repeat(PROMPT_BODY_MAX / 2)}</p>` }));
    const long = ticketPrompt(t, big, ctx);
    expect(long.length).toBeLessThan(PROMPT_MAX);
    expect(long).toContain("### 1. Customer email");
    expect(long).toContain("### 40. Customer email");
    expect(long).toMatch(/\[\d+ messages in between left out to keep this short\. Open the link for them\.\]/);
    expect(long).toContain("[The rest of this message is left out to keep this short.]");
  });
});

describe("ticketMessagePrompt", () => {
  it("copies one message, in full when its original is given, and no other message", () => {
    const m = msg({ body_html: "<p>Short</p>", has_quoted: true });
    const out = ticketMessagePrompt(t, m, { ...ctx, fullHtml: "<p>Short</p><blockquote><p>Earlier words</p></blockquote>" });
    expect(out.split("\n")[0]).toMatch(/^Below is one message from a support conversation/);
    expect(out).toContain("## Ticket #42");
    expect(out).toContain("## Message\n\n### Customer email");
    expect(out).toContain("Short\n\n> Earlier words");
    expect(out).not.toContain("quoted is left out");
  });

  it("says the quoted part is left out when the original is not there, and uses the text of a chat", () => {
    const chat = ticket({ ...t, channel: "chat", page_url: "https://example.com/pricing" });
    const out = ticketMessagePrompt(chat, msg({ body_html: "", body_text: "Hello <b>there</b>", has_quoted: true, to: [] }), { origin: ORIGIN });
    expect(out).toContain("### Customer chat message");
    expect(out).toContain("- Chat started on: https://example.com/pricing");
    expect(out).toContain("Hello <b>there</b>");
    expect(out).toContain("quoted is left out");
    expect(out).not.toContain("- To:");
    expect(out).not.toContain("- Mailbox:");
  });
});

describe("mailThreadPrompt", () => {
  const mail = (over: Partial<MailMessage>): MailMessage => ({
    id: "mm1",
    thread_id: "th1",
    account_id: "acc1",
    message_id: "x@example.com",
    from: { name: "Dana Diaz", email: "dana@example.com" },
    to: [{ name: "", email: "me@example.com" }],
    cc: [],
    bcc: [],
    reply_to: [],
    subject: "Bug",
    snippet: "",
    body_html: "<p>It broke.</p>",
    body_text: "It broke.",
    sent_at: "2026-11-02T08:30:00Z",
    unread: false,
    starred: false,
    draft: false,
    folder_ids: [],
    attachments: [],
    sent_by: null,
    outgoing: false,
    ...over,
  });
  const detail = {
    thread: { id: "th1", subject: "Bug", participants: [{ name: "Dana Diaz", email: "dana@example.com" }, { name: "Me", email: "me@example.com" }] },
    account: { id: "acc1", name: "Me", email: "me@example.com" },
    messages: [
      mail({
        id: "mm2",
        outgoing: true,
        from: { name: "Me", email: "me@example.com" },
        to: [{ name: "Dana Diaz", email: "dana@example.com" }],
        sent_at: "2026-11-02T09:00:00Z",
        body_html: '<p>Fixed. <img src="cid:pic1" alt=""></p><div class="gmail_quote">On Mon, Nov 2, 2026 at 8:30 AM Dana Diaz wrote:<blockquote><p>It broke.</p></blockquote></div>',
        attachments: [{ id: "0", filename: "fix.png", content_type: "image/png", size: 900, inline: true, content_id: "pic1", url: SIGNED }],
      }),
      mail({}),
      mail({ id: "mm3", draft: true, body_html: "<p>draft words</p>" }),
    ],
    comments: [{ id: "co1", body_html: "<p>team comment</p>" }],
    ticket: { id: "t9", number: 9, subject: "Bug" },
  } as unknown as MailThreadDetail;
  const out = mailThreadPrompt(detail, ORIGIN);

  it("copies the sent and received mail oldest first, with the conversation's link", () => {
    expect(out).toContain("## Email conversation");
    expect(out).toContain("- Account: Me <me@example.com>");
    expect(out).toContain("- People: Dana Diaz <dana@example.com>, Me <me@example.com>");
    expect(out).toContain(`- Ticket: #9 Bug (${ORIGIN}/inbox/open/t9)`);
    expect(out).toContain(`- Link: ${ORIGIN}/mail/all/th1`);
    expect(out.indexOf("### 1. Email received")).toBeLessThan(out.indexOf("### 2. Email sent from this account"));
    expect(out).toContain("- Date: 2026-11-02 08:30 UTC");
    expect(out).toContain("Fixed. [image: fix.png]");
    expect(out).toContain("- Inline images: fix.png (image/png, 900 B)");
  });

  it("leaves out the earlier mail a reply quoted, since it is in the messages above", () => {
    expect(out.match(/It broke\./g)).toHaveLength(1);
    expect(out).toContain("Fixed. [image: fix.png]\n\n[The earlier conversation this message quoted is left out.");
  });

  it("leaves out drafts, the team's comments and signed links", () => {
    expect(out).not.toContain("draft words");
    expect(out).not.toContain("team comment");
    expect(out).not.toContain("sig=");
  });
});
