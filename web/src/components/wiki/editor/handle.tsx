// The handle beside the block under the pointer, as in Notion: "+" adds a block below and
// opens the "/" menu; the grip drags the block elsewhere, or opens its menu on a click (turn
// into, colour, duplicate, copy a link to it, move, delete). Nested blocks get their own
// handle: list items, blocks in columns, callouts, toggles and quotes.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  ArrowDown,
  ArrowUp,
  Code2,
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Lightbulb,
  Link2,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Palette,
  Pilcrow,
  Plus,
  Quote,
  Repeat2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu as M } from "radix-ui";
import { Menu, MenuContent, MenuItem } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { menuItemCls } from "@/components/ui/menu";
import { copyOfBlock } from "./comment";
import { TONES, type Tone } from "./tones";

/** Parents whose children each get a handle. A callout or a quote moves as one block. */
const CONTAINERS = new Set(["doc", "column", "detailsContent"]);
/** Blocks that get a handle whatever holds them. */
const ITEMS = new Set(["listItem", "taskItem"]);

export type Block = { pos: number; node: PMNode; dom: HTMLElement };

export function blockAt(view: EditorView, x: number, y: number): Block | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const doc = view.state.doc;
  const $p = doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  let best: { pos: number; node: PMNode } | null = null;
  for (let d = 1; d <= $p.depth; d++) {
    const node = $p.node(d);
    if (CONTAINERS.has($p.node(d - 1).type.name) || ITEMS.has(node.type.name)) best = { pos: $p.before(d), node };
  }
  // An atom (an image, a file, a divider) is after the position, not around it.
  const after = $p.nodeAfter;
  if (hit.inside >= 0 && after?.isBlock && CONTAINERS.has($p.parent.type.name)) best = { pos: hit.inside, node: after };
  if (!best) return null;
  const dom = view.nodeDOM(best.pos);
  return dom instanceof HTMLElement ? { ...best, dom } : null;
}

/** Selects the text of a block, so the chain commands act on it. */
function selectIn(editor: Editor, b: Block) {
  const { state } = editor;
  const from = b.pos + 1;
  const to = b.pos + b.node.nodeSize - 1;
  if (b.node.isAtom || to <= from) return editor.commands.setNodeSelection(b.pos);
  return editor.commands.setTextSelection(TextSelection.between(state.doc.resolve(from), state.doc.resolve(to)));
}

/** Which "turn into" entry the block is now. */
function kindOf(node: PMNode): TurnId | "" {
  const first = node.firstChild;
  switch (node.type.name) {
    case "heading":
      return `h${node.attrs.level as 1 | 2 | 3}`;
    case "paragraph":
      return "text";
    case "codeBlock":
      return "code";
    case "blockquote":
      return "quote";
    case "callout":
      return "callout";
    case "details":
      return "toggle";
    case "bulletList":
    case "listItem":
      return "bullet";
    case "orderedList":
      return "ordered";
    case "taskList":
    case "taskItem":
      return "todo";
    default:
      return first ? kindOf(first) : "";
  }
}

export type TurnId = "text" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "todo" | "toggle" | "quote" | "callout" | "code";
type Turn = { id: TurnId; icon: ReactNode; run: (e: Editor) => void };

export function turnIntoOptions(): Turn[] {
  return [
    { id: "text", icon: <Pilcrow />, run: (e) => e.chain().focus().clearNodes().setParagraph().run() },
    { id: "h1", icon: <Heading1 />, run: (e) => e.chain().focus().clearNodes().setHeading({ level: 1 }).run() },
    { id: "h2", icon: <Heading2 />, run: (e) => e.chain().focus().clearNodes().setHeading({ level: 2 }).run() },
    { id: "h3", icon: <Heading3 />, run: (e) => e.chain().focus().clearNodes().setHeading({ level: 3 }).run() },
    { id: "bullet", icon: <List />, run: (e) => e.chain().focus().clearNodes().toggleBulletList().run() },
    { id: "ordered", icon: <ListOrdered />, run: (e) => e.chain().focus().clearNodes().toggleOrderedList().run() },
    { id: "todo", icon: <ListTodo />, run: (e) => e.chain().focus().clearNodes().toggleTaskList().run() },
    { id: "toggle", icon: <ListCollapse />, run: (e) => e.chain().focus().clearNodes().setDetails().run() },
    { id: "quote", icon: <Quote />, run: (e) => e.chain().focus().clearNodes().toggleBlockquote().run() },
    { id: "callout", icon: <Lightbulb />, run: (e) => e.chain().focus().clearNodes().setCallout().run() },
    { id: "code", icon: <Code2 />, run: (e) => e.chain().focus().clearNodes().setCodeBlock().run() },
  ];
}

/** Blocks that take a colour of their own (BlockColor in extensions.ts). */
const COLORED = new Set(["paragraph", "heading", "listItem", "taskItem", "blockquote", "details", "bulletList", "orderedList", "taskList"]);

function setBlockAttr(editor: Editor, b: Block, attrs: Record<string, unknown>) {
  const { tr } = editor.state;
  editor.view.dispatch(tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, ...attrs }));
}

function moveBlock(editor: Editor, b: Block, dir: -1 | 1) {
  const { state } = editor;
  const $pos = state.doc.resolve(b.pos);
  const index = $pos.index();
  const parent = $pos.parent;
  if (dir === -1 && index === 0) return;
  if (dir === 1 && index >= parent.childCount - 1) return;
  const sibling = parent.child(index + dir);
  const tr = state.tr.delete(b.pos, b.pos + b.node.nodeSize);
  const at = dir === -1 ? b.pos - sibling.nodeSize : b.pos + sibling.nodeSize;
  tr.insert(at, b.node);
  tr.setSelection(NodeSelection.create(tr.doc, at));
  editor.view.dispatch(tr.scrollIntoView());
}

export function BlockHandle({ editor, onCopyLink }: { editor: Editor; onCopyLink: (blockId: string) => void }) {
  const { t } = useTranslation("wiki");
  const wrap = useRef<HTMLDivElement>(null);
  const [block, setBlock] = useState<Block | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(false);
  menuRef.current = menu;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback((b: Block | null) => {
    const host = wrap.current?.parentElement;
    if (!b || !host) return setPos(null);
    const hr = host.getBoundingClientRect();
    const r = b.dom.getBoundingClientRect();
    const cs = getComputedStyle(b.dom);
    const lh = Number.parseFloat(cs.lineHeight) || 24;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const firstLine = b.node.isAtom ? Math.min(r.height, 32) : Math.min(r.height, lh + padTop * 2);
    setPos({ top: r.top - hr.top + firstLine / 2 - 12, left: r.left - hr.left - 50 });
  }, []);

  useEffect(() => {
    const view = editor.view;
    const host = wrap.current?.parentElement;
    if (!host) return;
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      if (menuRef.current || !editor.isEditable) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = view.dom.getBoundingClientRect();
        // The gutter left of the text counts as the block beside it.
        if (e.clientY < box.top - 4 || e.clientY > box.bottom + 4 || e.clientX < box.left - 72 || e.clientX > box.right + 24) {
          if (!wrap.current?.contains(e.target as Node)) setBlock(null);
          return;
        }
        const b = blockAt(view, Math.max(box.left + 4, Math.min(e.clientX, box.right - 4)), e.clientY);
        if (b) {
          setBlock(b);
          place(b);
        }
      });
    };
    const onKey = () => !menuRef.current && setBlock(null);
    document.addEventListener("mousemove", onMove);
    view.dom.addEventListener("keydown", onKey);
    const onScroll = () => block && place(block);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", onMove);
      view.dom.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [editor, place, block]);

  // A block that changed under the handle (typing, a move) is looked up again.
  useEffect(() => {
    const on = () => {
      if (!block) return;
      const n = editor.state.doc.nodeAt(block.pos);
      if (!n || n.type !== block.node.type) return setBlock(null);
      const dom = editor.view.nodeDOM(block.pos);
      if (dom instanceof HTMLElement) {
        const b = { pos: block.pos, node: n, dom };
        setBlock(b);
        place(b);
      }
    };
    editor.on("update", on);
    return () => {
      editor.off("update", on);
    };
  }, [editor, block, place]);

  const addBelow = (e: React.MouseEvent) => {
    if (!block) return;
    const above = e.altKey;
    const at = above ? block.pos : block.pos + block.node.nodeSize;
    const empty = !above && block.node.type.name === "paragraph" && block.node.content.size === 0;
    if (empty) {
      editor.chain().focus().setTextSelection(block.pos + 1).insertContent("/").run();
      return;
    }
    // A list item gets a sibling item; anything else a paragraph.
    const type = ITEMS.has(block.node.type.name) ? block.node.type : editor.schema.nodes.paragraph;
    const node = ITEMS.has(block.node.type.name) ? type.createAndFill({}, editor.schema.nodes.paragraph.create())! : type.create();
    const tr = editor.state.tr.insert(at, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + (ITEMS.has(block.node.type.name) ? 2 : 1))));
    editor.view.dispatch(tr);
    editor.chain().focus().insertContent("/").run();
  };

  const onDragStart = (e: React.DragEvent) => {
    if (!block) return;
    const view = editor.view;
    const sel = NodeSelection.create(view.state.doc, block.pos);
    view.dispatch(view.state.tr.setSelection(sel));
    const slice = sel.content();
    const { dom, text } = view.serializeForClipboard(slice);
    e.dataTransfer.clearData();
    e.dataTransfer.setData("text/html", dom.innerHTML);
    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setDragImage(block.dom, 0, 0);
    view.dragging = { slice, move: true };
  };

  const kind = block ? kindOf(block.node) : "";
  const colorable = block && (COLORED.has(block.node.type.name) || block.node.type.name === "callout");
  const blockId = (block?.node.attrs["block-id"] as string | undefined) ?? "";

  const run = (f: (b: Block) => void) => () => {
    if (block) f(block);
  };

  return (
    <div ref={wrap} contentEditable={false} data-print="hide" className="pointer-events-none absolute inset-0 z-10" aria-hidden={!block}>
      {block && pos && (
        <div className="wiki-handle pointer-events-auto absolute z-10 flex items-center gap-px" style={{ top: pos.top, left: pos.left }}>
          <Tooltip content={<TwoLines a={t("editor.handle.add")} b={t("editor.handle.addHint")} />}>
            <button type="button" aria-label={t("editor.handle.add")} onClick={addBelow} className="wiki-handle-btn">
              <Plus />
            </button>
          </Tooltip>
          <Menu open={menu} onOpenChange={setMenu}>
            <Tooltip content={<TwoLines a={t("editor.handle.drag")} b={t("editor.handle.dragHint")} />}>
              <M.Trigger asChild>
                <button
                  type="button"
                  draggable
                  onDragStart={onDragStart}
                  onDragEnd={() => setBlock(null)}
                  onMouseDown={() => selectIn(editor, block)}
                  aria-label={t("editor.handle.menu")}
                  className="wiki-handle-btn cursor-grab active:cursor-grabbing"
                >
                  <GripVertical />
                </button>
              </M.Trigger>
            </Tooltip>
            <MenuContent align="start" side="left" className="w-[230px]" onCloseAutoFocus={(e) => (e.preventDefault(), editor.commands.focus())}>
              <M.Sub>
                <M.SubTrigger className={menuItemCls}>
                  <Repeat2 />
                  <span className="flex-1">{t("editor.handle.turnInto")}</span>
                </M.SubTrigger>
                <M.Portal>
                  <M.SubContent sideOffset={6} className="z-50 min-w-[200px] rounded-lg border border-line bg-raised p-1 shadow-pop animate-pop-in">
                    {turnIntoOptions().map((o) => (
                      <M.Item key={o.id} className={cn(menuItemCls, kind === o.id && "font-medium")} onSelect={() => (selectIn(editor, block), o.run(editor))}>
                        {o.icon}
                        <span className="flex-1">{t(`editor.block.${o.id}`)}</span>
                        {kind === o.id && <span className="size-1.5 rounded-full bg-fg" />}
                      </M.Item>
                    ))}
                  </M.SubContent>
                </M.Portal>
              </M.Sub>
              {colorable && (
                <M.Sub>
                  <M.SubTrigger className={menuItemCls}>
                    <Palette />
                    <span className="flex-1">{t("editor.handle.color")}</span>
                  </M.SubTrigger>
                  <M.Portal>
                    <M.SubContent sideOffset={6} className="z-50 max-h-[min(420px,calc(var(--radix-dropdown-menu-content-available-height)/var(--od-zoom,1)))] min-w-[200px] overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-pop animate-pop-in">
                      <ColorItems
                        node={block.node}
                        onText={(tone) =>
                          block.node.type.name === "callout" ? undefined : setBlockAttr(editor, block, { color: tone })
                        }
                        onBg={(tone) => (block.node.type.name === "callout" ? setBlockAttr(editor, block, { tone: tone ?? "gray" }) : setBlockAttr(editor, block, { background: tone }))}
                      />
                    </M.SubContent>
                  </M.Portal>
                </M.Sub>
              )}
              <M.Separator className="my-1 h-px bg-line" />
              <MenuItem icon={<Copy />} shortcut="mod d" onSelect={run((b) => editor.chain().insertContentAt(b.pos + b.node.nodeSize, copyOfBlock(b.node)).run())}>
                {t("editor.handle.duplicate")}
              </MenuItem>
              {blockId && (
                <MenuItem icon={<Link2 />} onSelect={() => onCopyLink(blockId)}>
                  {t("editor.handle.copyLink")}
                </MenuItem>
              )}
              <MenuItem icon={<ArrowUp />} shortcut="mod shift up" onSelect={run((b) => moveBlock(editor, b, -1))}>
                {t("editor.handle.moveUp")}
              </MenuItem>
              <MenuItem icon={<ArrowDown />} shortcut="mod shift down" onSelect={run((b) => moveBlock(editor, b, 1))}>
                {t("editor.handle.moveDown")}
              </MenuItem>
              <M.Separator className="my-1 h-px bg-line" />
              <MenuItem danger icon={<Trash2 />} shortcut="del" onSelect={run((b) => (editor.view.dispatch(editor.state.tr.delete(b.pos, b.pos + b.node.nodeSize)), setBlock(null)))}>
                {t("editor.handle.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      )}
    </div>
  );
}

function ColorItems({ node, onText, onBg }: { node: PMNode; onText: (t: Tone | null) => void; onBg: (t: Tone | null) => void }) {
  const { t } = useTranslation("wiki");
  const callout = node.type.name === "callout";
  const text = (node.attrs.color as Tone | null) ?? null;
  const bg = callout ? ((node.attrs.tone as Tone) ?? "gray") : ((node.attrs.background as Tone | null) ?? null);
  return (
    <>
      {!callout && (
        <>
          <div className="label-caps px-2 pb-1 pt-1.5">{t("editor.handle.text")}</div>
          <M.Item className={menuItemCls} onSelect={() => onText(null)}>
            <span className="wiki-swatch-text">A</span>
            <span className="flex-1">{t("editor.tone.default")}</span>
            {!text && <span className="size-1.5 rounded-full bg-fg" />}
          </M.Item>
          {TONES.map((tone) => (
            <M.Item key={tone} className={menuItemCls} onSelect={() => onText(tone)}>
              <span className="wiki-swatch-text" data-color={tone}>
                A
              </span>
              <span className="flex-1">{t(`editor.tone.${tone}`)}</span>
              {text === tone && <span className="size-1.5 rounded-full bg-fg" />}
            </M.Item>
          ))}
        </>
      )}
      <div className="label-caps px-2 pb-1 pt-2">{t("editor.handle.background")}</div>
      {!callout && (
        <M.Item className={menuItemCls} onSelect={() => onBg(null)}>
          <span className="wiki-swatch-bg">A</span>
          <span className="flex-1">{t("editor.tone.default")}</span>
          {!bg && <span className="size-1.5 rounded-full bg-fg" />}
        </M.Item>
      )}
      {TONES.map((tone) => (
        <M.Item key={tone} className={menuItemCls} onSelect={() => onBg(tone)}>
          <span className="wiki-swatch-bg" data-bg={tone}>
            A
          </span>
          <span className="flex-1">{t(`editor.tone.${tone}`)}</span>
          {bg === tone && <span className="size-1.5 rounded-full bg-fg" />}
        </M.Item>
      ))}
    </>
  );
}

function TwoLines({ a, b }: { a: string; b: string }) {
  return (
    <span className="flex flex-col py-0.5 leading-4">
      <span>{a}</span>
      <span className="font-normal opacity-60">{b}</span>
    </span>
  );
}

export { moveBlock };
