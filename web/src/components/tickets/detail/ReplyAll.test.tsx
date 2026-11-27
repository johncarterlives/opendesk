import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Mailbox, Message, Ticket } from "@/lib/api/types";
import { q } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { InboundRecipients, ReplyAllButton, useReplyAll, type ReplyAllChange } from "./ReplyAll";

vi.mock("@/lib/api/endpoints", () => ({ api: { tickets: { messages: vi.fn(() => new Promise(() => {})) }, mailboxes: { list: vi.fn(() => new Promise(() => {})) } } }));

beforeAll(() => loadAgentCatalogs("fr"));

const ticket = { id: "t1", channel: "email", contact: { id: "c1", name: "Supplier", email: "sales@supplier.test", avatar_url: "" } } as unknown as Ticket;
const mailboxes = [
  { id: "mb1", email: "info@example-desk.test", aliases: [], forwarding_address: "info-x1@inbound.opendesk.test" },
  { id: "mb2", email: "support@example-desk.test", aliases: ["help@example-desk.test"] },
] as unknown as Mailbox[];
const inbound = (p: Partial<Message>): Message =>
  ({
    id: "m1",
    ticket_id: "t1",
    kind: "reply",
    direction: "inbound",
    from_email: "sales@supplier.test",
    reply_to: "",
    to: ["info@example-desk.test"],
    cc: [],
    bcc: [],
    created_at: "2026-11-09T16:13:39Z",
    ...p,
  }) as Message;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useSession.setState({ user: { id: "u1", email: "nora@example-desk.test" } as never });
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode, messages: Message[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(q.mailboxes().queryKey, mailboxes);
  qc.setQueryData(q.messages(ticket.id).queryKey, messages);
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}

/** The reply box's part of the draft: its Cc and what Reply all added, as Composer keeps them. */
function Box({ initialCc = [], bcc = [], to = ["sales@supplier.test"], spy }: { initialCc?: string[]; bcc?: string[]; to?: string[]; spy?: (p: ReplyAllChange) => void }) {
  const [d, setD] = useState<{ cc: string[]; replyAll?: string[] }>({ cc: initialCc });
  const all = useReplyAll(ticket, true, { to, contactEmail: "sales@supplier.test", cc: d.cc, bcc, replyAll: d.replyAll });
  return (
    <div>
      <ReplyAllButton
        r={all}
        onChange={(p) => {
          spy?.(p);
          setD({ cc: p.cc, replyAll: p.replyAll });
        }}
      />
      <output>{d.cc.join("|")}</output>
    </div>
  );
}
const button = () => host.querySelector<HTMLButtonElement>("button[aria-pressed]");
const cc = () => host.querySelector("output")!.textContent;

describe("ReplyAllButton", () => {
  it("adds the email's other recipients to Cc, and Reply takes them out again", async () => {
    const spy = vi.fn();
    await mount(<Box spy={spy} />, [inbound({ to: ["bart@agent.test", "info@agent.test", "info@example-desk.test"] })]);
    expect(button()!.textContent).toBe("Reply all");
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button()!.click());
    expect(cc()).toBe("bart@agent.test|info@agent.test");
    expect(spy).toHaveBeenLastCalledWith({ cc: ["bart@agent.test", "info@agent.test"], replyAll: ["bart@agent.test", "info@agent.test"], showCc: true });
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button()!.click());
    expect(cc()).toBe("");
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the Cc the agent typed", async () => {
    await mount(<Box initialCc={["ana@client.test", "INFO@agent.test"]} />, [inbound({ to: ["bart@agent.test", "info@example-desk.test"], cc: ["info@agent.test"] })]);
    await act(async () => button()!.click());
    expect(cc()).toBe("ana@client.test|INFO@agent.test|bart@agent.test");
    await act(async () => button()!.click());
    expect(cc()).toBe("ana@client.test|INFO@agent.test");
  });

  it("is not offered when nobody else was on the latest email", async () => {
    // Our other mailboxes, their aliases and the writer's own address don't count.
    await mount(<Box />, [
      inbound({ id: "old", to: ["bart@agent.test", "info@example-desk.test"] }),
      inbound({ id: "m2", to: ["info@example-desk.test", "support@example-desk.test"], cc: ["HELP@example-desk.test", "nora@example-desk.test"] }),
    ]);
    expect(button()).toBeNull();
  });

  it("is not offered when the reply already reaches them (To or Bcc)", async () => {
    await mount(<Box to={["sales@supplier.test", "bart@agent.test"]} bcc={["info@agent.test"]} />, [inbound({ to: ["bart@agent.test", "info@agent.test", "info@example-desk.test"] })]);
    expect(button()).toBeNull();
  });

  it("reads the latest email that passed sender checks, follows its reply address and leaves out our forwarding address", async () => {
    await mount(<Box />, [
      inbound({
        id: "ok",
        from_email: "colleague@supplier.test",
        reply_to: "collect@elsewhere.test",
        reply_address: "",
        to: ["info-x1@inbound.opendesk.test", "bart@agent.test"],
      }),
      inbound({ id: "spoofed", auth_failed: true, cc: ["someone@elsewhere.test"] }),
    ]);
    await act(async () => button()!.click());
    expect(cc()).toBe("colleague@supplier.test|bart@agent.test");
  });

  it("is not offered when the only email naming others failed sender checks", async () => {
    await mount(<Box />, [inbound({ auth_failed: true, cc: ["someone@elsewhere.test"] })]);
    expect(button()).toBeNull();
  });

  it("reads in French", async () => {
    await i18n.changeLanguage("fr");
    await mount(<Box />, [inbound({ cc: ["bart@agent.test"] })]);
    expect(button()!.textContent).toBe("Répondre à tous");
  });
});

describe("InboundRecipients", () => {
  it("lists every recipient, our own address included, To then Cc", async () => {
    await mount(<InboundRecipients to={["bart@agent.test", "info@example-desk.test"]} cc={["info@agent.test"]} />);
    expect(host.textContent).toBe("To bart@agent.test, info@example-desk.test · Cc info@agent.test");
  });
  it("leaves out an empty To or Cc", async () => {
    await mount(<InboundRecipients to={["a@x.test", "b@x.test"]} cc={[]} />);
    expect(host.textContent).toBe("To a@x.test, b@x.test");
    await mount(<InboundRecipients to={[]} cc={["a@x.test", "b@x.test"]} />);
    expect(host.textContent).toBe("Cc a@x.test, b@x.test");
  });
  it("reads in French and German", async () => {
    await i18n.changeLanguage("fr");
    await mount(<InboundRecipients to={["info@example-desk.test"]} cc={["bart@agent.test"]} />);
    expect(host.textContent).toBe("À info@example-desk.test · Cc bart@agent.test");
    await loadAgentCatalogs("de");
    await i18n.changeLanguage("de");
    await mount(<InboundRecipients to={["info@example-desk.test"]} cc={["bart@agent.test"]} />);
    expect(host.textContent).toBe("An info@example-desk.test · Cc bart@agent.test");
  });
});
