import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ui/confirm";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { setWorkspaceId } from "@/lib/api/client";
import { api, rows } from "@/lib/api/endpoints";
import type { MailComment, MailThreadDetail, UserRef } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { installMock } from "@/mock";
import { db } from "@/mock/db";
import { useReplyTargets } from "./Comments";
import { ThreadView } from "./ThreadView";

// Replies to a comment (contracts/collab.md "Replies").

vi.mock("@tanstack/react-router", async (original) => ({ ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => vi.fn() }));

const bea: UserRef = { id: "u-bea", name: "Bea Agent", email: "bea@example.com", avatar_url: null };
const at = "2026-11-01T10:00:00Z";
const comment = (id: string, body_html: string, extra: Partial<MailComment> = {}): MailComment => ({
  id, thread_id: "", author: bea, body_html, mentions: [], reply_to: null, parent: null, parent_deleted: false, created_at: at, updated_at: at, ...extra,
});

let detail: MailThreadDetail;
let qc: QueryClient;
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(async () => {
  installMock();
  setWorkspaceId(db.workspaces[0].workspace.id);
  await i18n.changeLanguage("en");
  const account = rows(await api.collab.accounts.list())[0];
  const threads = await api.collab.threads.list({ account_id: account.id });
  detail = { ...(await api.collab.threads.get(threads.data[0].id)), can_act: true };
  const tid = detail.thread.id;
  detail.comments = [
    { ...comment("c1", "<p>Customer wants a refund.</p><p>Second line</p>"), thread_id: tid },
    { ...comment("c2", "<p>On it</p>", { reply_to: "c1", parent: { author: bea, excerpt: "Customer wants a refund." } }), thread_id: tid },
    { ...comment("c3", "<p>Done</p>", { parent_deleted: true }), thread_id: tid },
  ];
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.collabStatus, { enabled: true });
  qc.setQueryData(qk.mailAccounts, []);
  qc.setQueryData(qk.mailThread(tid), detail);
  useReplyTargets.setState({ byThread: {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  // The editor scrolls to its selection when focused; jsdom lays nothing out.
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  qc.clear();
  setWorkspaceId(null);
  vi.unstubAllGlobals();
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<QueryClientProvider client={qc}><TooltipProvider><ConfirmProvider>
      <ThreadView threadId={detail.thread.id} onClose={() => undefined} onAction={() => undefined} markReadOnOpen={false} />
    </ConfirmProvider></TooltipProvider></QueryClientProvider>);
  });
}

it("quotes the comment a reply answers, and leads to it", async () => {
  await mount();
  const quote = host!.querySelector<HTMLButtonElement>("button[aria-label='Go to the original comment by Bea Agent']");
  expect(quote?.textContent).toBe("Bea AgentCustomer wants a refund.");
  // The quote sits above the reply's own text, inside the reply.
  expect(host!.querySelector("#comment-c2")?.contains(quote!)).toBe(true);
  await act(async () => quote?.click());
  const parent = host!.querySelector<HTMLElement>("#comment-c1");
  expect(parent?.scrollIntoView).toHaveBeenCalled();
  expect(parent?.dataset.findFlash).toBeDefined();
  // A reply whose original is gone says so, and leads nowhere.
  expect(host!.querySelector("#comment-c3")?.textContent).toContain("Original comment deleted");
  expect(host!.querySelector("#comment-c3 button[aria-label^='Go to']")).toBeNull();
  // A comment that replies to nothing quotes nothing.
  expect(host!.querySelector("#comment-c1 button[aria-label^='Go to']")).toBeNull();
});

it("puts a reply chip above the comment bar, focused, until X or Escape cancels it", async () => {
  await mount();
  expect(host!.querySelector("footer")?.textContent).not.toContain("Replying to");
  const reply = host!.querySelector<HTMLButtonElement>("#comment-c1 button[aria-label='Reply']");
  expect(reply).not.toBeNull();
  await act(async () => reply?.click());
  expect(host!.querySelector("footer")?.textContent).toContain("Replying to Bea Agent: Customer wants a refund.");
  await vi.waitFor(() => expect(document.activeElement).toBe(host!.querySelector('footer [contenteditable="true"]')));
  expect(useReplyTargets.getState().byThread[detail.thread.id]?.id).toBe("c1");

  await act(async () => host!.querySelector<HTMLButtonElement>("footer button[aria-label='Cancel reply']")?.click());
  expect(useReplyTargets.getState().byThread[detail.thread.id]).toBeUndefined();
  await vi.waitFor(() => expect(host!.querySelector("footer")?.textContent).not.toContain("Replying to"));

  // Escape cancels the reply and keeps the comment bar open.
  await act(async () => host!.querySelector<HTMLButtonElement>("#comment-c2 button[aria-label='Reply']")?.click());
  expect(host!.querySelector("footer")?.textContent).toContain("Replying to Bea Agent: On it");
  await act(async () => {
    host!.querySelector<HTMLElement>('footer [contenteditable="true"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(useReplyTargets.getState().byThread[detail.thread.id]).toBeUndefined();
  await vi.waitFor(() => expect(host!.querySelector("footer")?.textContent).not.toContain("Replying to"));
  expect(host!.querySelector('footer [contenteditable="true"]')).not.toBeNull();
});

it("keeps the reply target with the conversation's unsent comment, and sends it", async () => {
  await mount();
  await act(async () => host!.querySelector<HTMLButtonElement>("#comment-c1 button[aria-label='Reply']")?.click());
  // Reading something else and coming back: the reply is still waiting.
  await act(async () => root?.unmount());
  root = createRoot(host!);
  await act(async () => {
    root?.render(<QueryClientProvider client={qc}><TooltipProvider><ConfirmProvider>
      <ThreadView threadId={detail.thread.id} onClose={() => undefined} onAction={() => undefined} markReadOnOpen={false} />
    </ConfirmProvider></TooltipProvider></QueryClientProvider>);
  });
  await act(async () => host!.querySelector<HTMLButtonElement>("footer button[aria-label='Comment']")?.click());
  expect(host!.querySelector("footer")?.textContent).toContain("Replying to Bea Agent: Customer wants a refund.");

  const send = vi.spyOn(api.collab.threads, "comment").mockResolvedValue(comment("c4", "<p>Refunded</p>", { thread_id: detail.thread.id, reply_to: "c1", parent: { author: bea, excerpt: "Customer wants a refund." } }));
  // The editor's view carries its tiptap editor: type through it as the keyboard would.
  const editor = host!.querySelector<HTMLElement & { editor?: { commands: { insertContent: (s: string) => boolean } } }>('footer [contenteditable="true"]');
  await act(async () => {
    editor?.editor?.commands.insertContent("Refunded");
  });
  // The bar's own Comment button, not the Reply / Comment switch.
  await act(async () => [...host!.querySelectorAll<HTMLButtonElement>("footer button:not([role='radio'])")].find((b) => b.textContent === "Comment")?.click());
  expect(send).toHaveBeenCalledWith(detail.thread.id, expect.objectContaining({ reply_to: "c1" }));
  expect(useReplyTargets.getState().byThread[detail.thread.id]).toBeUndefined();
});

it("shows an AI note as the key's, in the AI tone, never with the face of the member who made the key", async () => {
  const tid = detail.thread.id;
  const withFace = { ...bea, avatar_url: "https://example.com/bea.png" };
  detail.comments = [
    { ...comment("n1", "<p>Past the refund window: a person decides.</p>", { author: withFace, ai_note_by: "Support drafter" }), thread_id: tid },
    { ...comment("n2", "<p>I'll decide.</p>", { reply_to: "n1", parent: { author: withFace, excerpt: "Past the refund window: a person decides.", ai_note_by: "Support drafter" } }), thread_id: tid },
  ];
  detail.ai_skips = [{ client: "Support drafter", reason: "Refund outside the 30-day window", at }];
  qc.setQueryData(qk.mailThread(tid), detail);
  await mount();

  const note = host!.querySelector<HTMLElement>("#comment-n1")!;
  // The AI mark stands where the member's avatar would: no photo, no initials, no member's name.
  expect(note.querySelector("[data-ai-mark]")?.className).toContain("text-tone-violet");
  expect(note.querySelector("img")).toBeNull();
  expect(note.querySelector("[title='Support drafter'], [title='Bea Agent']")).toBeNull();
  expect(note.textContent).not.toContain("Bea Agent");
  const author = [...note.querySelectorAll("span")].find((s) => s.textContent === "Support drafter");
  expect(author?.className).toContain("text-tone-violet");
  expect([...note.querySelectorAll("span")].some((s) => s.textContent === "AI note")).toBe(true);
  // A reply to it quotes the key, not the member.
  expect(host!.querySelector("#comment-n2 button[aria-label='Go to the original comment by Support drafter']")).not.toBeNull();
  // A person's comment keeps their face.
  expect(host!.querySelector("#comment-n2 [title='Bea Agent']")).not.toBeNull();

  // The skip is one line in the same tone.
  const skip = [...host!.querySelectorAll("p")].find((p) => p.textContent === "Support drafter looked at this and did not draft: Refund outside the 30-day window");
  expect(skip?.className).toContain("text-tone-violet");
});
