import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Editor, Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { MessageSquareText } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createSuggestions, savedReplySuggestion } from "@/components/tickets/detail/suggestions";
import { Picker } from "@/components/ui/picker";
import { Tooltip } from "@/components/ui/tooltip";
import { q } from "@/lib/queries";
import { sanitizeHtml } from "@/lib/sanitize";

/** Mail has no ticket context. Only offer workspace-wide replies that don't need filling. */
export function useMailSavedReplies(onInsert: () => void) {
  const query = useQuery(q.savedReplies());
  const replies = useMemo(() => (query.data ?? []).filter((r) => !r.team_id && !/\{\{|\{%/.test(r.body_html)), [query.data]);
  // The editor's extension stays mounted while the cache refreshes or another Mail composer opens.
  const [store] = useState(createSuggestions);
  const latest = useRef({ replies, onInsert });
  latest.current = { replies, onInsert };
  const extension = useMemo(() => savedReplySuggestion(() => latest.current.replies, (editor, range, reply) => {
    const current = latest.current.replies.find((r) => r.id === reply.id);
    if (current && insertMailSavedReply(editor, current.body_html, range)) latest.current.onInsert();
  }, store), [store]);
  return { replies, query, store, extension };
}

/** Replace only a slash command, or insert at the caret (before any selected draft text). */
function insertMailSavedReply(editor: Editor, html: string, range?: Range) {
  if (!editor.isEditable || editor.isDestroyed) return false;
  return editor.chain()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .insertContentAt(range ?? editor.state.selection.from, sanitizeHtml(html))
    .run();
}

export function MailSavedReplyButton({ saved, getEditor, onInsert, disabled }: {
  saved: ReturnType<typeof useMailSavedReplies>;
  getEditor: () => Editor | null | undefined;
  onInsert: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation(["collab", "inbox", "ui", "common"]);
  const [open, setOpen] = useState(false);
  const insertedIn = useRef<Editor | null>(null);
  const { replies, query } = saved;
  const label = t("inbox:composer.savedReplies");
  return (
    <Picker
      side="top"
      align="end"
      width={300}
      open={open}
      onOpenChange={setOpen}
      onCloseAutoFocus={(event) => {
        const editor = insertedIn.current;
        insertedIn.current = null;
        if (!editor || editor.isDestroyed) return;
        event.preventDefault();
        editor.commands.focus();
      }}
      placeholder={t("inbox:composer.searchReplies")}
      emptyText={query.isPending ? t("ui:loading") : query.isError && !query.data ? t("composer.savedRepliesFailed") : replies.length ? t("inbox:composer.noReplies") : t("composer.noMailSavedReplies")}
      value={null}
      items={replies.map((r) => ({ value: r.id, label: r.title, hint: r.shortcut ? `/${r.shortcut}` : undefined, keywords: [r.title, r.shortcut] }))}
      onSelect={(id) => {
        const reply = replies.find((r) => r.id === id);
        const editor = getEditor();
        if (!reply || !editor || !insertMailSavedReply(editor, reply.body_html)) return;
        insertedIn.current = editor;
        onInsert();
      }}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-1">
          <Link to="/settings/saved-replies" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-hover hover:text-fg">
            {t("composer.manageSavedReplies")}
          </Link>
          {query.isError && (
            <button type="button" onClick={() => void query.refetch()} className="rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-hover hover:text-fg">
              {t("common:actions.retry")}
            </button>
          )}
        </div>
      }
      trigger={
        <Tooltip content={label} shortcut="/">
          <button type="button" disabled={disabled} aria-label={label} className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-50">
            <MessageSquareText aria-hidden className="size-[15px]" />
          </button>
        </Tooltip>
      }
    />
  );
}
