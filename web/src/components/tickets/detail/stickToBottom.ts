// Holds the ticket timeline where the agent reads (Timeline.tsx). It opens on the latest message,
// its first line in view however long it is, and stays there while what it shows settles: emails
// drawn in their own frames grow once loaded, images arrive, activity and side conversations come
// in after the messages, the reply box grows and shrinks below. A new message while the agent is
// at the end comes into view the same way. Only the agent scrolling lets go; scrolling back down
// to the end holds it again.

/** How close to the end still counts as at the end, in pixels. */
export const STICK_SLACK = 80;
/** How long after the agent's wheel, touch, key or pointer a scroll counts as theirs, in ms,
 * even while the content changes size. */
const INTENT_MS = 1000;
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** The latest message: the scroll position that puts its top at the top of the box, and how many
 * messages there are (a new one is a new latest message; a sent one swapping its id is not). */
export type Latest = { readonly top: number; readonly count: number };

export type Stick = {
  /** Whether the box is held. */
  readonly pinned: boolean;
  /** Goes where the hold is if held (new items, a live reply growing). */
  follow(): void;
  /** Lets go, for a jump to a message further up (showInTimeline). */
  release(): void;
  stop(): void;
};

/**
 * Holds `el` (the scrolling box) at its end while it or `content` (what scrolls in it) changes size.
 *
 * `latest`, when given, keeps the hold from going past the latest message's top (latestMessageFloor):
 * a message taller than the box is read from its first line, and history after it (triage, rules,
 * API keys setting a status or a tag) is no reason to scroll it away. The hold goes to the end, or
 * to that top if it is higher, until the agent scrolls themselves, and again for each new message
 * that arrives while they are at the end.
 */
export function stickToBottom(el: HTMLElement, content: Element, latest?: () => Latest | null): Stick {
  let pinned = true;
  // How many messages there were when the agent last scrolled: the latest message then has been
  // read past, and holds no longer; a newer one does.
  let passed = 0;
  let last = el.scrollTop;
  let height = el.scrollHeight;
  const count = () => latest?.()?.count ?? 0;
  /** Where the hold is: the end, or higher up, at the top of a latest message not read past yet. */
  const target = () => {
    const end = el.scrollHeight - el.clientHeight;
    const l = latest?.();
    return l && l.count > passed ? Math.max(0, Math.min(end, l.top)) : end;
  };
  // When the agent last reached for the scroll. A scroll while the content changed size (a frame
  // shrinking and growing again within a frame, the browser clamping or anchoring the scroll) is
  // the layout's, unless they just did; a wheel over an email's frame never reaches the box, but
  // leaves the content as it was.
  let input = Number.NEGATIVE_INFINITY;
  const reach = () => {
    input = performance.now();
  };
  const onKey = (e: KeyboardEvent) => {
    if (UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) reach();
  };
  const follow = () => {
    if (!pinned) return;
    const to = target();
    el.scrollTop = to >= el.scrollHeight - el.clientHeight ? el.scrollHeight : to;
    last = el.scrollTop;
    height = el.scrollHeight;
  };
  const onScroll = () => {
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const resized = el.scrollHeight !== height;
    const theirs = performance.now() - input < INTENT_MS;
    height = el.scrollHeight;
    // Content growing or shrinking moves the end, not the agent. The agent scrolling, up or down,
    // reads on from where they put it: only the end holds again.
    if (el.scrollTop !== last && (theirs || !resized)) {
      passed = count();
      pinned = gap < STICK_SLACK;
    } else if (gap < STICK_SLACK) pinned = true;
    last = el.scrollTop;
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  for (const type of ["wheel", "touchmove", "pointerdown"] as const) el.addEventListener(type, reach, { passive: true });
  el.ownerDocument.addEventListener("keydown", onKey);
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
  ro?.observe(el);
  ro?.observe(content);
  follow();
  return {
    get pinned() {
      return pinned;
    },
    follow,
    release: () => {
      pinned = false;
      passed = count();
    },
    stop: () => {
      el.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchmove", "pointerdown"] as const) el.removeEventListener(type, reach);
      el.ownerDocument.removeEventListener("keydown", onKey);
      ro?.disconnect();
    },
  };
}

/** Room kept above the latest message when the hold stops at it, in pixels. */
export const FLOOR_PAD = 16;

/**
 * The latest message in `content` (the last `article[id^="m-"]`, as MessageItem draws them): the
 * scroll position of `el` that puts its top just below the top of the box, so it reads from its
 * first line whatever its height. Null when there is no message yet.
 */
export function latestMessageFloor(el: HTMLElement, content: Element): Latest | null {
  const messages = content.querySelectorAll('article[id^="m-"]');
  const m = messages[messages.length - 1];
  if (!m) return null;
  const top = m.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  return { top: top - FLOOR_PAD, count: messages.length };
}
