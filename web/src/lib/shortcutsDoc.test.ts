// The keyboard shortcuts guide (docs/.../guides/keyboard-shortcuts.mdx) lists every shortcut
// of the registry with its default keys, under its scope's table: a new or changed shortcut
// fails here until the guide says so.

import { describe, expect, it } from "vitest";
import guide from "../../../docs/src/content/docs/guides/keyboard-shortcuts.mdx?raw";
import { parseStep, SHORTCUT_LIST } from "./shortcuts";

/** Each scope's table: its rows' keys, as the guide writes them with <kbd>. */
function tables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const parts = guide.split(/\{\/\* scope: (\w+) \*\/\}/);
  for (let i = 1; i < parts.length; i += 2) {
    const rows = parts[i + 1]!.split("\n").filter((l: string) => l.startsWith("| <kbd>"));
    out.set(parts[i]!, rows.map((r: string) => r.split(" | ")[0]!));
  }
  return out;
}

const SHOWN: Record<string, string> = { arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", escape: "esc", delete: "del", "\\": "\\\\" };

/** A binding as the guide writes it: "mod+shift+p" → "<kbd>mod</kbd> <kbd>shift</kbd> <kbd>p</kbd>", steps joined by "then". */
function asGuide(binding: string): string {
  return binding
    .split(" ")
    .map((step) => {
      const p = parseStep(step);
      const keys = p ? [...(["mod", "alt", "shift"] as const).filter((m) => p.mods.has(m)), p.key] : [step];
      return keys.map((k) => `<kbd>${SHOWN[k] ?? k}</kbd>`).join(" ");
    })
    .join(" then ");
}

describe("the keyboard shortcuts guide", () => {
  it("lists every shortcut with its default keys, in its scope's table", () => {
    const t = tables();
    const missing = SHORTCUT_LIST.filter((s) => !(t.get(s.scope) ?? []).some((cell) => cell.split(" or ").some((k) => k.replace(/^\| /, "").trim() === asGuide(s.keys)))).map((s) => `${s.scope} ${s.id}: ${asGuide(s.keys)}`);
    expect(missing).toEqual([]);
  });
});
