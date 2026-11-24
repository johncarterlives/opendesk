import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReadOnOpen } from "./useReadOnOpen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const onAction = vi.fn();
type Props = Parameters<typeof useReadOnOpen>[0];
const detail = { can_act: true, thread: { id: "t1", unread: true }, messages: [{ id: "m1", draft: false }] };
let replied: ReturnType<typeof useReadOnOpen> = () => undefined;
function View(props: Props) { replied = useReadOnOpen(props); return null; }
async function show(over: Partial<Props> = {}) {
  await act(async () => root.render(<View detail={detail} current enabled onAction={onAction} {...over} />));
}
beforeEach(() => { onAction.mockClear(); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); });

it("reads the first delivery and new mail shown in the same conversation", async () => {
  await show();
  expect(onAction).toHaveBeenCalledExactlyOnceWith("read", { silent: true });
  await show({ detail: { ...detail, thread: { ...detail.thread, unread: false } } });
  await show({ detail: { ...detail, messages: [...detail.messages, { id: "m2", draft: false }] } });
  expect(onAction).toHaveBeenCalledTimes(2);
});
it("leaves explicit unread alone, including after saving a draft", async () => {
  await show();
  await show({ detail: { ...detail, thread: { ...detail.thread, unread: false } } });
  await show();
  await show({ detail: { ...detail, messages: [...detail.messages, { id: "draft", draft: true }] } });
  expect(onAction).toHaveBeenCalledTimes(1);
});
it("waits for current data and respects the preference and read-only access", async () => {
  await show({ current: false });
  await show({ enabled: false });
  await show({ detail: { ...detail, can_act: false } });
  expect(onAction).not.toHaveBeenCalled();
  await show();
  expect(onAction).toHaveBeenCalledTimes(1);
});
it("does not retry a rejected read in a loop, and tries on a new visit", async () => {
  await show();
  await show({ detail: { ...detail } });
  expect(onAction).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  await show();
  expect(onAction).toHaveBeenCalledTimes(2);
});
it("leaves a conversation opened on a waiting AI draft unread through review and discard, and reads it on a reply", async () => {
  const aiDraft = { id: "d1", draft: true, drafted_by_ai: "aidevops" };
  await show({ detail: { ...detail, messages: [...detail.messages, aiDraft] } });
  // Discarded: the draft is gone, the visit still reads nothing, new mail included.
  await show();
  await show({ detail: { ...detail, messages: [...detail.messages, { id: "m2", draft: false }] } });
  expect(onAction).not.toHaveBeenCalled();
  replied("other", true);
  replied("t1", false);
  expect(onAction).not.toHaveBeenCalled();
  replied("t1", true);
  expect(onAction).toHaveBeenCalledExactlyOnceWith("read", { silent: true });
});
it("holds for an AI draft a person saved over, and a reply reads nothing extra where opening already read", async () => {
  await show({ detail: { ...detail, messages: [...detail.messages, { id: "d1", draft: true, ai_draft: { id: "a1", client: "aidevops", outcome: null, has_feedback: false } }] } });
  expect(onAction).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await show();
  expect(onAction).toHaveBeenCalledOnce();
  replied("t1", true);
  expect(onAction).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await show({ enabled: false, detail: { ...detail, messages: [...detail.messages, { id: "d1", draft: true, drafted_by_ai: "aidevops" }] } });
  replied("t1", true);
  expect(onAction).toHaveBeenCalledOnce();
});
it("waits past a read cached copy when reopening an unread conversation", async () => {
  await show({ current: false, detail: { ...detail, thread: { ...detail.thread, unread: false } } });
  expect(onAction).not.toHaveBeenCalled();
  await show();
  expect(onAction).toHaveBeenCalledExactlyOnceWith("read", { silent: true });
});
