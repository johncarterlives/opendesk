// "Run a command" in the command menu: every shortcut the app answers on this page, by its
// name, with its keys beside it. Choosing one presses its keys, so it does exactly what the
// keys do, after the menu has closed.

import { Command } from "cmdk";
import { Keyboard } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Kbd } from "@/components/ui/kbd";
import { useHereScopes, useOfferedShortcuts, useShortcutLabels } from "@/lib/shortcutLabels";
import { bindingOf, displayKeys, parseStep, useShortcutKeys, type ShortcutDef, type ShortcutScope } from "@/lib/shortcuts";

/** Scopes whose keys work wherever the command menu was opened from. */
const ANYWHERE: readonly ShortcutScope[] = ["global"];
/** Shortcuts that only make sense while something has the focus, or that the menu has already. */
const NOT_HERE = new Set(["global.palette", "sidebar.done", "sidebar.next", "sidebar.previous", "sidebar.rename", "sidebar.moveUp", "sidebar.moveDown", "sidebar.pin", "sidebar.hide", "sidebar.remove", "mail.tabLeft", "mail.tabRight"]);

/** Presses binding on the page as the keyboard would. */
export function pressBinding(binding: string) {
  for (const step of binding.split(" ")) {
    const p = parseStep(step);
    if (!p) return;
    const key = p.key === "space" ? " " : p.key.length === 1 && p.mods.has("shift") ? p.key.toUpperCase() : NAMED_KEYS[p.key] ?? p.key;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        metaKey: p.mods.has("mod") && mac,
        ctrlKey: p.mods.has("mod") && !mac,
        altKey: p.mods.has("alt"),
        shiftKey: p.mods.has("shift"),
      }),
    );
  }
}

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

type ItemProps = { children: ReactNode; onSelect: () => void; icon?: ReactNode; hint?: ReactNode; value: string; keywords?: string[] };

export function ShortcutCommands({ item: Item, groupCls, go }: { item: (p: ItemProps) => ReactNode; groupCls: string; go: (fn: () => void) => void }) {
  const { t } = useTranslation("shortcuts");
  const label = useShortcutLabels();
  const offered = useOfferedShortcuts();
  const here = useHereScopes();
  const bindings = useShortcutKeys((s) => s.bindings);
  const runnable = (s: ShortcutDef) => !s.fixed && !NOT_HERE.has(s.id) && (ANYWHERE.includes(s.scope) || here.includes(s.scope));
  const seen = new Set<string>();
  const list = offered.filter((s) => {
    if (!runnable(s) || !bindingOf(s.id, bindings)) return false;
    const l = label(s);
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  if (!list.length) return null;
  return (
    <Command.Group heading={t("palette.group")} className={groupCls}>
      {list.map((s) => {
        const keys = bindingOf(s.id, bindings)!;
        return (
          <Item
            key={s.id}
            value={`command ${label(s)} ${s.id}`}
            keywords={[t("palette.run"), t(`scopes.${s.scope}`)]}
            icon={<Keyboard />}
            hint={<Kbd>{displayKeys(keys)}</Kbd>}
            // After the menu closes and gives the focus back, so the page hears the keys.
            onSelect={() => go(() => requestAnimationFrame(() => requestAnimationFrame(() => pressBinding(keys))))}
          >
            {label(s)}
          </Item>
        );
      })}
    </Command.Group>
  );
}
