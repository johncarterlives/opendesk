import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/i18n";
import type { Contact } from "@/lib/api/types";
import { emptyNewTicket, isChat, isLog, type NewTicketDraft } from "./newTicket";
import { NewTicketCopies, NewTicketTo } from "./NewTicketFields";
import type { NewTicketState } from "./useNewTicket";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ada = { id: "c-ada", name: "Ada Lovelace", email: "ada@example.com" } as Contact;

describe("a new ticket's recipients", () => {
  let host: HTMLDivElement;
  let root: Root;
  let draft: NewTicketDraft;
  const qc = new QueryClient();
  const render = () =>
    act(async () => {
      const s = { draft, set: (p: Partial<NewTicketDraft>) => ((draft = { ...draft, ...p }), void render()), chat: isChat(draft), log: isLog(draft) } as unknown as NewTicketState;
      root.render(
        <QueryClientProvider client={qc}>
          <NewTicketTo s={s} />
          <NewTicketCopies s={s} />
        </QueryClientProvider>,
      );
    });
  const remove = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label*="${name}"]`)!;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("lists everyone an email goes to, and hands the ticket to the next when the contact is removed", async () => {
    draft = { ...emptyNewTicket, kind: "reply", channel: "email", mailbox: "m1", to: { contact: ada }, moreTo: [{ email: "deputy@example.com" }] };
    await render();
    expect(host.textContent).toContain("Ada Lovelace");
    expect(host.textContent).toContain("deputy@example.com");
    expect(host.textContent).toContain("Add someone");
    await act(async () => remove("Ada Lovelace").click());
    expect(draft.to).toEqual({ email: "deputy@example.com" });
    expect(draft.moreTo).toEqual([]);
  });

  it("offers Cc and Bcc on an email, and keeps a note to the contact alone", async () => {
    draft = { ...emptyNewTicket, kind: "reply", channel: "email", mailbox: "m1", to: { contact: ada } };
    await render();
    const ask = [...host.querySelectorAll("button")].find((b) => b.textContent === "Add Cc or Bcc")!;
    await act(async () => ask.click());
    expect(host.querySelector('input[aria-label="Cc"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="Bcc"]')).not.toBeNull();

    draft = { ...draft, kind: "note", moreTo: [{ email: "deputy@example.com" }] };
    await render();
    expect(host.textContent).not.toContain("deputy@example.com");
    expect(host.textContent).not.toContain("Add someone");
    expect(host.querySelector('input[aria-label="Cc"]')).toBeNull();
  });
});
