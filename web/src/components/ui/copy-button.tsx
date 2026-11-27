import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Morph } from "@/components/motion";
import { Tooltip } from "./tooltip";

/**
 * Copies text; false when the browser refused. Text still being worked out goes to the
 * clipboard as a pending item, so a browser that allows a copy only during the click
 * (Safari) still takes it once it is ready.
 */
export async function copyText(text: string | Promise<string>) {
  if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((s) => new Blob([s], { type: "text/plain" })) })]);
      return true;
    } catch {
      // Not every browser takes a pending item; the plain copy below may still work.
    }
  }
  try {
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const { t } = useTranslation("ui");
  const [done, setDone] = useState(false);
  return (
    <Tooltip content={done ? t("copied") : (label ?? t("copy"))}>
      <button
        type="button"
        aria-label={label ?? t("copy")}
        onClick={async (e) => {
          e.stopPropagation();
          if (await copyText(value)) {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          }
        }}
        className={cn("flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg", className)}
      >
        <Morph k={done ? "done" : "copy"}>{done ? <Check className="size-3.5 text-tone-green" /> : <Copy className="size-3.5" />}</Morph>
      </button>
    </Tooltip>
  );
}

/** A read-only value in a field with a copy button: forwarding addresses, secrets, snippets. */
export function CopyField({ value, mono = true, className, multiline }: { value: string; mono?: boolean; className?: string; multiline?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-1 rounded-md border border-line bg-sunken py-1 pl-2.5 pr-1", className)}>
      {multiline ? (
        <pre className={cn("min-w-0 flex-1 overflow-x-auto whitespace-pre py-1 text-xs leading-5 text-fg", mono && "mono")}>{value}</pre>
      ) : (
        <span className={cn("min-w-0 flex-1 truncate py-0.5 text-[12.5px] text-fg", mono && "mono")}>{value}</span>
      )}
      <CopyButton value={value} />
    </div>
  );
}
