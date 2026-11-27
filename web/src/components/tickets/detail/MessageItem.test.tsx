import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/lib/api/types";
import { setClock } from "@/lib/format";
import { qk } from "@/lib/queries";
import { MessageItem, originalRecipients } from "./MessageItem";

vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<object>()), useNavigate: () => vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Intl separates with no-break spaces; compare on plain spaces. */
const sp = (s: string | null | undefined) => (s ?? "").replace(/[\u00a0\u202f]/g, " ");

// Local times, so the day boundaries hold in any timezone.
const NOON = new Date(2026, 10, 9, 12, 0);

const message = (patch: Partial<Message> = {}): Message =>
  ({
    id: "m1",
    ticket_id: "t1",
    kind: "reply",
    direction: "inbound",
    author: { type: "contact", user: null, contact: { id: "c1", name: "Ada Buyer", email: "ada@example.com" } },
    body_html: "<p>Where is my order?</p>",
    body_text: "Where is my order?",
    has_quoted: false,
    subject: "Order",
    from_email: "ada@example.com",
    from_name: "Ada Buyer",
    to: [],
    cc: [],
    bcc: [],
    attachments: [],
    delivery_status: "delivered",
    delivery_error: "",
    ai: false,
    created_at: "2026-11-09T08:45:00",
    edited_at: null,
    ...patch,
  }) as Message;

describe("MessageItem's time", () => {
  let root: Root | null = null;

  beforeAll(async () => {
    await loadAgentCatalogs("en");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
  });
  afterAll(() => vi.useRealTimers());
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    setClock("auto");
    await i18n.changeLanguage("en");
  });

  async function render(m: Message) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <QueryClientProvider client={qc}>
          <ConfirmProvider>
            <TooltipProvider>
              <MessageItem m={m} />
            </TooltipProvider>
          </ConfirmProvider>
        </QueryClientProvider>,
      ),
    );
    return document.querySelector("time")!;
  }

  it("shows only the time on today's messages", async () => {
    await i18n.changeLanguage("en-US");
    const time = await render(message());
    expect(sp(time.textContent)).toBe("8:45 AM");
    expect(time.getAttribute("datetime")).toBe("2026-11-09T08:45:00");
  });

  it("shows the day with the time on an older message, and the year outside this one", async () => {
    await i18n.changeLanguage("en-US");
    expect(sp((await render(message({ created_at: "2026-11-08T20:45:00" }))).textContent)).toBe("Nov 8 · 8:45 PM");
    await act(async () => root!.unmount());
    expect(sp((await render(message({ created_at: "2025-11-08T20:45:00" }))).textContent)).toBe("Nov 8, 2025 · 8:45 PM");
  });

  it("follows the person's clock and the app's language", async () => {
    await i18n.changeLanguage("fr");
    setClock("12h");
    expect(sp((await render(message({ created_at: "2026-11-08T20:45:00" }))).textContent)).toBe("8 nov. · 8:45 PM");
    await act(async () => root!.unmount());
    setClock("24h");
    expect(sp((await render(message({ created_at: "2026-11-08T20:45:00" }))).textContent)).toBe("8 nov. · 20:45");
  });

  it("dates a note and a deleted message's marker the same way", async () => {
    await i18n.changeLanguage("en-US");
    setClock("24h");
    const note = message({ kind: "note", direction: "outbound", author: { type: "user", user: { id: "u1", name: "Lea Martin", email: "lea@margin.test", avatar_url: null }, contact: null } } as Partial<Message>);
    expect(sp((await render({ ...note, created_at: "2026-11-07T09:10:00" })).textContent)).toBe("Nov 7 · 09:10");
    await act(async () => root!.unmount());
    const deleted = { ...note, deleted_at: "2026-11-08T17:30:00", deleted_by: note.author.user, body_html: "", body_text: "" };
    expect(sp((await render(deleted)).textContent)).toBe("Nov 8 · 17:30");
  });
});

describe("MessageItem's original recipient", () => {
  let root: Root | null = null;

  beforeAll(async () => {
    await loadAgentCatalogs("en");
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  /** The line beside the sender's name, in a workspace with two addresses. */
  async function line(m: Message) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false, staleTime: Infinity } } });
    qc.setQueryData(qk.mailboxes, [{ id: "mb1", email: "support@new.example", aliases: ["sales@new.example"] }]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <QueryClientProvider client={qc}>
          <ConfirmProvider>
            <TooltipProvider>
              <MessageItem m={m} receivedAt="support@new.example" />
            </TooltipProvider>
          </ConfirmProvider>
        </QueryClientProvider>,
      ),
    );
    return sp(document.querySelector("header [data-ph-mask]:not(.shrink-0)")?.textContent);
  }
  const inbound = (patch: Partial<Message>) => message({ mailbox_id: "mb1", received_at: "support@new.example", ...patch } as Partial<Message>);

  it("shows the To header of a forwarded copy beside the address that received it", async () => {
    expect(await line(inbound({ to: ["orders@old.example"] }))).toBe("ada@example.com to orders@old.example · received at support@new.example");
  });

  it("keeps the line of an email written to the receiving address", async () => {
    expect(await line(inbound({ to: ["support@new.example"] }))).toBe("ada@example.com to support@new.example");
    await act(async () => root!.unmount());
    expect(await line(inbound({ to: ["other@partner.example", "support@new.example"] }))).toBe("ada@example.com to support@new.example");
  });

  it("compares addresses whatever their case", async () => {
    expect(await line(inbound({ to: ["Support@New.Example"] }))).toBe("ada@example.com to support@new.example");
    await act(async () => root!.unmount());
    expect(await line(inbound({ to: ["Orders@Old.Example"] }))).toBe("ada@example.com to Orders@Old.Example · received at support@new.example");
  });

  it("keeps the line when the To header is empty", async () => {
    expect(await line(inbound({ to: [] }))).toBe("ada@example.com to support@new.example");
  });

  it("names the first of several recipients and counts the others", async () => {
    const m = inbound({ to: ["orders@old.example", "lea@old.example", "max@old.example"] });
    expect(await line(m)).toBe("ada@example.com to orders@old.example +2 · received at support@new.example");
  });

  it("shows it when our address is only in Cc or Bcc, without the Cc list", async () => {
    const m = inbound({ to: ["other@partner.example"], cc: ["support@new.example", "third@partner.example"] });
    expect(await line(m)).toBe("ada@example.com to other@partner.example · received at support@new.example");
  });

  it("reads the same in German and French", async () => {
    await loadAgentCatalogs("de");
    await i18n.changeLanguage("de");
    const m = inbound({ to: ["orders@old.example", "lea@old.example"] });
    expect(await line(m)).toBe("ada@example.com an orders@old.example +1 · eingegangen bei support@new.example");
    await act(async () => root!.unmount());
    await loadAgentCatalogs("fr");
    await i18n.changeLanguage("fr");
    expect(await line(m)).toBe("ada@example.com à orders@old.example +1 · reçu sur support@new.example");
  });

  it("keeps the full To list out of session replay when its tooltip opens", async () => {
    await line(inbound({ to: ["orders@old.example", "lea@old.example"] }));
    const trigger = document.querySelector<HTMLElement>("header [data-ph-mask] [tabindex='0']");
    await act(async () => trigger!.focus());
    const tip = document.querySelector("[data-radix-popper-content-wrapper]");
    const walk = document.createTreeWalker(tip!, NodeFilter.SHOW_TEXT);
    const shown: Node[] = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes("lea@old.example")) shown.push(n);
    expect(shown.length).toBeGreaterThan(0);
    for (const n of shown) expect(n.parentElement!.closest("[data-ph-mask]")).not.toBeNull();
  });

  it("lists every recipient of an email written to several people under its header, To then Cc", async () => {
    const row = () => sp(document.querySelector("[data-recipients]")?.textContent);
    const m = inbound({ to: ["other@partner.example", "support@new.example"], cc: ["third@partner.example"] });
    expect(await line(m)).toBe("ada@example.com to support@new.example");
    expect(row()).toBe("To other@partner.example, support@new.example · Cc third@partner.example");
    expect(document.querySelector("[data-recipients]")!.closest("[data-ph-mask]")).not.toBeNull();
    await act(async () => root!.unmount());
    await line(inbound({ to: ["orders@old.example"], cc: ["support@new.example"] }));
    expect(row()).toBe("To orders@old.example · Cc support@new.example");
    await act(async () => root!.unmount());
    await line(inbound({ to: ["support@new.example"] }));
    expect(document.querySelector("[data-recipients]")).toBeNull();
    await act(async () => root!.unmount());
    await line(inbound({ to: ["other@partner.example", "support@new.example"], direction: "outbound" }));
    expect(document.querySelector("[data-recipients]")).toBeNull();
  });

  it("leaves outbound mail, and mail with no recorded receiving address, alone", () => {
    expect(originalRecipients(inbound({ to: ["orders@old.example"] }))).toEqual({ to: ["orders@old.example"], address: "support@new.example" });
    expect(originalRecipients(inbound({ to: ["orders@old.example"], received_at: "" }))).toBeNull();
    expect(originalRecipients(inbound({ to: ["orders@old.example"], direction: "outbound" }))).toBeNull();
    expect(originalRecipients(inbound({ to: [" ", ""] }))).toBeNull();
  });
});
