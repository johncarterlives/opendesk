import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { setWorkspaceId } from "@/lib/api/client";
import { api, rows } from "@/lib/api/endpoints";
import type { MailThread } from "@/lib/api/types";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import { ThreadRow } from "./ThreadRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let thread: MailThread;
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  installMock();
  setWorkspaceId(db.workspaces[0].workspace.id);
  await i18n.changeLanguage("en");
  const account = rows(await api.collab.accounts.list())[0];
  const threads = await api.collab.threads.list({ account_id: account.id });
  thread = {
    ...threads.data[0],
    ai_draft: { draft_id: "draft-1", drafted_by: "aidevops", snippet: "Thank you for the email", to: [{ name: "Karen", email: "karen@example.com" }], record_id: "ai-1" },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setWorkspaceId(null);
  vi.unstubAllGlobals();
});

async function render(busy = false) {
  const onOpen = vi.fn();
  const onDraft = vi.fn();
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ThreadRow
          thread={thread}
          active={false}
          focused={false}
          selected={false}
          selecting={false}
          compact
          labels={[]}
          ownEmails={new Set()}
          onOpen={onOpen}
          onToggle={() => undefined}
          onDraft={onDraft}
          draftBusy={busy}
        />
      </TooltipProvider>,
    ),
  );
  return { onOpen, onDraft };
}

const strip = () => [...host.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === "AI draft by aidevops")!.parentElement!;
const button = (name: string) => [...strip().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;

it("opens the conversation on a click anywhere on the AI draft strip outside its buttons", async () => {
  const { onOpen, onDraft } = await render();
  await act(async () => strip().querySelector<HTMLElement>("[data-ph-mask]")?.click());
  expect(onOpen).toHaveBeenCalledWith(thread);
  await act(async () => [...strip().querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === "AI draft by aidevops")?.click());
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(onDraft).not.toHaveBeenCalled();
});

it("keeps Send, Edit and Discard acting on the draft only, even while busy", async () => {
  const { onOpen, onDraft } = await render();
  for (const [name, action] of [["Send", "send"], ["Edit", "edit"], ["Discard", "discard"]] as const) {
    await act(async () => button(name).click());
    expect(onDraft).toHaveBeenLastCalledWith(thread, action);
  }
  expect(onOpen).not.toHaveBeenCalled();

  const busy = await render(true);
  // A disabled button gets no click of its own; a click dispatched on it still must not open the conversation.
  await act(async () => button("Send").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(busy.onOpen).not.toHaveBeenCalled();
  expect(busy.onDraft).not.toHaveBeenCalled();
});
