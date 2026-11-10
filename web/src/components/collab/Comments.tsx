// The team's discussion of a conversation: comments only teammates who can see it
// read, never the sender. @ mentions a teammate (the ticket notes' mention list);
// a mention of someone who cannot see it shares the conversation with them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api/endpoints";
import type { MailComment, MailThreadDetail, Member } from "@/lib/api/types";
import { isBlankHtml, mentionIds } from "@/lib/collab/html";
import { fullDate, relShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import { dur, ease, springs } from "@/lib/motion";
import { qk, q } from "@/lib/queries";
import { sanitizeHtml } from "@/lib/sanitize";
import { atLeast, useRole, useSession } from "@/lib/session";
import { RichEditor, type RichEditorHandle } from "@/components/editor/RichEditor";
import { mentionExtension, SuggestionPopup, useSuggest } from "@/components/tickets/detail/suggestions";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";

function useMentionExtension() {
  const { data: members } = useQuery(q.members());
  const ref = useRef<Member[]>([]);
  ref.current = members ?? [];
  // One extension per editor; it reads the members as they are when @ is typed.
  return useMemo(() => [mentionExtension(() => ref.current)], []);
}

function patchComments(qc: ReturnType<typeof useQueryClient>, threadId: string, fn: (c: MailComment[]) => MailComment[]) {
  qc.setQueryData<MailThreadDetail>(qk.mailThread(threadId), (old) => {
    if (!old) return old;
    const comments = fn(old.comments);
    return { ...old, comments, thread: { ...old.thread, comment_count: comments.length } };
  });
}

function CommentItem({ c, threadId, canAct, fresh }: { c: MailComment; threadId: string; canAct: boolean; fresh: boolean }) {
  const { t } = useTranslation("collab");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const me = useSession((s) => s.user?.id);
  const admin = atLeast(useRole(), "admin");
  // An AI note is the key's words: it can be deleted, never edited as if a person wrote it.
  const mine = !!c.author && c.author.id === me && !c.ai_note_by;
  const [editing, setEditing] = useState(false);
  const [html, setHtml] = useState(c.body_html);
  const extensions = useMentionExtension();
  const editor = useRef<RichEditorHandle>(null);
  const body = useMemo(() => sanitizeHtml(c.body_html), [c.body_html]);
  const name = c.ai_note_by ? t("comments.aiNoteBy", { name: c.ai_note_by }) : (c.author?.name ?? t("comments.someone"));
  const ownAINote = !!c.ai_note_by && !!c.author && c.author.id === me;

  const save = useMutation({
    mutationFn: (body_html: string) => api.collab.comments.update(c.id, body_html),
    onSuccess: (n) => {
      patchComments(qc, threadId, (list) => list.map((x) => (x.id === n.id ? n : x)));
      setEditing(false);
    },
    onError: (e) => toast.error(e),
  });
  const remove = () =>
    confirm.show(
      t("comments.deleteConfirm"),
      async () => {
        await api.collab.comments.remove(c.id);
        patchComments(qc, threadId, (list) => list.filter((x) => x.id !== c.id));
      },
      { title: t("comments.deleteTitle"), confirmLabel: t("comments.delete"), danger: true },
    );

  return (
    <div id={`comment-${c.id}`} className="group/comment relative flex scroll-my-4 gap-2.5">
      {fresh && (
        // A comment that arrived while the conversation is open (yours or a teammate's) glows once.
        <motion.span aria-hidden className="pointer-events-none absolute -inset-x-2 -inset-y-1.5 rounded-md bg-hover" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 1.4, delay: 0.5, ease: ease.out }} />
      )}
      <Avatar name={name} src={c.author?.avatar_url} size="sm" className="relative mt-0.5" />
      <div className="relative min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12.5px] font-medium">{name}</span>
          <Tooltip content={fullDate(c.created_at)}>
            <time dateTime={c.created_at} className="mono shrink-0 text-[10.5px] text-fg-4">
              {relShort(c.created_at)}
            </time>
          </Tooltip>
          {c.updated_at !== c.created_at && <span className="text-[10.5px] text-fg-4">{t("comments.edited")}</span>}
          {canAct && (mine || ownAINote || admin) && !editing && (
            <Menu>
              <MenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("comments.menu")}
                  className="ml-auto flex size-6 items-center justify-center rounded-md text-fg-4 opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/comment:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </MenuTrigger>
              <MenuContent>
                {mine && (
                  <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                    {t("comments.edit")}
                  </MenuItem>
                )}
                <MenuItem icon={<Trash2 />} danger onSelect={remove}>
                  {t("comments.delete")}
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
        {editing ? (
          <div className="mt-1 rounded-md border border-line bg-surface">
            <RichEditor
              ref={editor}
              value={html}
              onChange={setHtml}
              extensions={extensions}
              autofocus
              toolbar="none"
              contentClassName="min-h-[40px] text-[12.5px]"
              ariaLabel={t("comments.edit")}
              onSubmit={() => !isBlankHtml(html) && save.mutate(html)}
            />
            <div className="flex justify-end gap-1.5 px-2 pb-2">
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                {t("comments.cancel")}
              </Button>
              <Button size="xs" variant="primary" loading={save.isPending} disabled={isBlankHtml(html)} onClick={() => save.mutate(html)}>
                {t("comments.save")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="prose-od mt-0.5 text-[12.5px] text-fg" data-ph-mask dangerouslySetInnerHTML={{ __html: body }} />
        )}
      </div>
    </div>
  );
}

/** The comments, in the conversation under its messages; written in the pinned `CommentBar`. */
export function Comments({ detail }: { detail: MailThreadDetail }) {
  const { t } = useTranslation("collab");
  const reduce = useReducedMotion();
  // The comments there when it opened; any other arrived since, and enters.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(detail.comments.map((c) => c.id));
  if (!detail.comments.length) return null;
  return (
    <section aria-label={t("comments.title")} className="rounded-lg border border-dashed border-note-line bg-note px-4 py-3">
      <div className="flex items-center gap-1.5">
        <Lock className="size-3 text-fg-3" />
        <h3 className="text-[12px] font-semibold tracking-[-0.01em]">{t("comments.title")}</h3>
        <Count n={detail.comments.length} className="text-[10.5px] text-fg-4" />
      </div>
      <p className="mt-0.5 text-[11.5px] text-fg-3">{t("comments.hint")}</p>
      <ul className="mt-3 flex flex-col gap-3">
        <AnimatePresence initial={false} mode="popLayout">
          {detail.comments.map((c) => (
            <motion.li
              key={c.id}
              layout={reduce ? false : "position"}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
              transition={springs.row}
            >
              <CommentItem c={c} threadId={detail.thread.id} canAct={detail.can_act} fresh={!seen.current?.has(c.id)} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

/** A number that ticks over when it changes: the new one rises in. */
export function Count({ n, className }: { n: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={cn("mono relative inline-flex overflow-hidden tabular-nums", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={n}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: "70%" }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-70%" }}
          transition={springs.snap}
        >
          {n}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// A comment not posted yet waits for its conversation while you read another.
const unsent = new Map<string, string>();

export type CommentBarHandle = { focus: () => void };

// The editor's buttons opening and the reply buttons stepping aside move as one.
const barMotion = { duration: dur.base, ease: ease.out };

/**
 * Writing a comment, pinned under the conversation so it is there however long the
 * mail is: one line until it is used, then the editor, who reads it and the buttons.
 * `children` sit beside the line (the reply buttons) and step aside while writing.
 */
export const CommentBar = forwardRef<CommentBarHandle, { detail: MailThreadDetail; onPosted?: (id: string) => void; children?: ReactNode }>(function CommentBar({ detail, onPosted, children }, ref) {
  const { t } = useTranslation("collab");
  const qc = useQueryClient();
  const threadId = detail.thread.id;
  const reduce = useReducedMotion();
  const [html, setHtmlState] = useState(() => unsent.get(threadId) ?? "");
  const setHtml = (v: string) => {
    setHtmlState(v);
    if (isBlankHtml(v)) unsent.delete(threadId);
    else unsent.set(threadId, v);
  };
  const [focused, setFocused] = useState(false);
  const editor = useRef<RichEditorHandle>(null);
  const extensions = useMentionExtension();
  const writing = focused || !isBlankHtml(html);
  const add = useMutation({
    mutationFn: (body_html: string) => api.collab.threads.comment(threadId, { body_html, mentions: mentionIds(body_html) }),
    onSuccess: (c) => {
      patchComments(qc, threadId, (list) => (list.some((x) => x.id === c.id) ? list : [...list, c]));
      editor.current?.clear();
      setHtml("");
      onPosted?.(c.id);
    },
    onError: (e) => toast.error(e),
  });
  const submit = () => {
    const body = editor.current?.editor?.getHTML() ?? html;
    if (!isBlankHtml(body) && !add.isPending) add.mutate(body);
  };
  const leave = () => {
    editor.current?.editor?.commands.blur();
    setFocused(false);
  };
  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);

  return (
    <div className="flex items-center">
      <div
        className={cn(
          "min-w-0 flex-1 rounded-md border border-dashed border-note-line bg-note transition-colors duration-150 hover:border-line-strong",
          writing && "border-solid border-line-strong bg-surface",
        )}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <div className="flex items-start">
          <Lock aria-hidden className="ml-2.5 mt-[9px] size-3 shrink-0 text-fg-4" />
          <RichEditor
            ref={editor}
            value={html}
            onChange={setHtml}
            extensions={extensions}
            toolbar="none"
            placeholder={t("comments.placeholder")}
            ariaLabel={t("comments.placeholder")}
            className="max-h-[40vh] min-w-0 flex-1"
            contentClassName="min-h-0 px-2 py-[5px] text-[12.5px] leading-5"
            onFocus={() => setFocused(true)}
            onKeyDown={(e) => {
              // Escape leaves the comment as it is (a mention list open closes first).
              if (e.key !== "Escape" || useSuggest.getState().open) return false;
              leave();
              return true;
            }}
            onSubmit={submit}
          />
        </div>
        <AnimatePresence initial={false}>
          {writing && (
            <motion.div
              key="actions"
              initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={barMotion}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 pb-2 pl-[30px] pr-2">
                <p className="min-w-0 flex-1 truncate text-[11px] text-fg-4">{t("comments.hint")}</p>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    editor.current?.clear();
                    setHtml("");
                    leave();
                  }}
                >
                  {t("comments.cancel")}
                </Button>
                <Tooltip content={t("comments.add")} shortcut="mod enter">
                  <Button size="xs" variant="primary" loading={add.isPending} disabled={isBlankHtml(html)} onClick={submit}>
                    {t("comments.add")}
                  </Button>
                </Tooltip>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {!writing && children && (
          <motion.div
            key="aside"
            // Everything that takes room is inside, so at width 0 it takes none and leaving moves nothing.
            // The margin gives focus rings room past the edge and closes with the width.
            initial={reduce ? { opacity: 0 } : { opacity: 0, width: 0, marginRight: 0 }}
            animate={{ opacity: 1, width: "auto", marginRight: -4 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, width: 0, marginRight: 0 }}
            transition={barMotion}
            className="-my-1 shrink-0 overflow-hidden"
          >
            <div className="flex w-max items-center gap-1.5 py-1 pl-1.5 pr-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
      <SuggestionPopup />
    </div>
  );
});
