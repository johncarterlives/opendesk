import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAgentCatalogs } from "@/i18n";
import { api } from "@/lib/api/endpoints";
import type { Mailbox, Message } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { ticket } from "@/lib/test/fixtures";
import { useCopyForAgent } from "./copyForAgent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (patch: Partial<Message> = {}): Message =>
  ({
    id: "m1",
    ticket_id: "t1",
    kind: "reply",
    direction: "inbound",
    author: { type: "contact", user: null, contact: { id: "c1", name: "Ada Buyer", email: "ada@example.com", avatar_url: null } },
    body_html: "<p>The export button does nothing.</p>",
    body_text: "",
    has_quoted: false,
    subject: "Export",
    from_email: "ada@example.com",
    from_name: "Ada Buyer",
    to: ["help@example.com"],
    cc: [],
    bcc: [],
    attachments: [],
    delivery_status: "none",
    delivery_error: "",
    ai: false,
    created_at: "2026-11-09T08:45:00Z",
    edited_at: null,
    ...patch,
  }) as Message;

describe("useCopyForAgent", () => {
  let root: Root | null = null;
  const written: string[] = [];

  beforeAll(async () => {
    await loadAgentCatalogs("en");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s: string) => void written.push(s) } });
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    written.length = 0;
    vi.restoreAllMocks();
  });

  async function hook() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    qc.setQueryData(qk.mailboxes, [{ id: "mb1", name: "Help", email: "help@example.com" } as Mailbox]);
    let out: ReturnType<typeof useCopyForAgent> = null;
    function Probe() {
      out = useCopyForAgent(ticket({ number: 7, subject: "Export", mailbox_id: "mb1", contact: { id: "c1", name: "Ada Buyer", email: "ada@example.com", avatar_url: null } }));
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>));
    return out!;
  }

  it("copies one message with the email it quoted, read in full", async () => {
    const original = vi.spyOn(api.messages, "original").mockResolvedValue({ full_html: "<p>The export button does nothing.</p><blockquote><p>Earlier: it worked last week.</p></blockquote>" });
    const copy = await hook();
    await act(async () => {
      copy.message(message({ has_quoted: true }));
      await vi.waitFor(() => expect(written).toHaveLength(1));
    });
    expect(original).toHaveBeenCalledWith("m1");
    expect(written[0]).toContain("## Ticket #7");
    expect(written[0]).toContain("- Mailbox: Help <help@example.com>");
    expect(written[0]).toContain("### Customer email");
    expect(written[0]).toContain("> Earlier: it worked last week.");
  });

  it("still copies the message as shown when its original can't be read", async () => {
    vi.spyOn(api.messages, "original").mockRejectedValue(new Error("gone"));
    const copy = await hook();
    await act(async () => {
      copy.message(message({ has_quoted: true }));
      await vi.waitFor(() => expect(written).toHaveLength(1));
    });
    expect(written[0]).toContain("The export button does nothing.");
    expect(written[0]).toContain("quoted is left out");
  });

  it("copies the whole ticket with its internal notes labelled", async () => {
    const copy = await hook();
    const note = message({ id: "m2", kind: "note", direction: "outbound", author: { type: "user", user: { id: "u1", name: "Lea", email: "lea@example.com", avatar_url: null }, contact: null }, body_html: "<p>Known bug.</p>", created_at: "2026-11-09T09:00:00Z" });
    await act(async () => {
      copy.ticket([note, message()]);
      await vi.waitFor(() => expect(written).toHaveLength(1));
    });
    expect(written[0].indexOf("### 1. Customer email")).toBeGreaterThan(0);
    expect(written[0]).toContain("### 2. Internal note (only the team sees it)\n\n- From: Lea\n");
  });
});
