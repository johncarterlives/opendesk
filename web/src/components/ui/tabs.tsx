import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Tabs as T } from "radix-ui";
import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const spring = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 } as const;
const TabsCtx = createContext<{ value?: string; id: string }>({ id: "" });

/** Radix tabs that know the active value, so the indicator can slide between triggers. */
export function Tabs({ value, defaultValue, onValueChange, ...rest }: ComponentProps<typeof T.Root>) {
  const id = useId();
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  return (
    <TabsCtx.Provider value={{ value: current, id }}>
      <LayoutGroup id={id}>
        <T.Root
          value={current}
          onValueChange={(v) => {
            setInner(v);
            onValueChange?.(v);
          }}
          {...rest}
        />
      </LayoutGroup>
    </TabsCtx.Provider>
  );
}
export const TabsContent = T.Content;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <T.List className={cn("flex shrink-0 items-center gap-1 border-b border-line px-3", className)}>{children}</T.List>;
}

export function TabsTrigger({ value, children, icon, count }: { value: string; children: ReactNode; icon?: ReactNode; count?: number }) {
  const ctx = useContext(TabsCtx);
  const reduce = useReducedMotion();
  const active = ctx.value === value;
  return (
    <T.Trigger
      value={value}
      className="group relative inline-flex h-10 items-center gap-1.5 px-2 text-[12.5px] text-fg-3 outline-none transition-colors hover:text-fg data-[state=active]:font-medium data-[state=active]:text-fg [&_svg]:size-3.5"
    >
      {icon}
      {children}
      {count !== undefined && <span className="mono text-[11px] text-fg-4">{count}</span>}
      {active && (
        <motion.span
          layoutId={reduce ? undefined : "tab-indicator"}
          transition={spring}
          className="absolute inset-x-1.5 -bottom-px h-[1.5px] rounded-full bg-fg"
        />
      )}
    </T.Trigger>
  );
}

/** Compact segmented toggle (Reply / Note, ranges). */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  className,
  size = "sm",
  "aria-label": ariaLabel,
}: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode; icon?: ReactNode }[];
  className?: string;
  size?: "xs" | "sm";
  "aria-label"?: string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    // Dark mode tints the track with white so it shows on any surface: dialogs and popovers sit on
    // --raised, which is the same grey as --hover.
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex items-center rounded-md bg-hover p-0.5 dark:bg-white/[0.07] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative inline-flex items-center gap-1.5 rounded-md font-medium text-fg-3 transition-colors duration-100 hover:text-fg [&_svg]:size-3.5",
            size === "xs" ? "h-6 px-2 text-xs" : "h-[26px] px-2.5 text-[12.5px]",
            value === o.value && "text-fg",
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={reduce ? undefined : `seg-${id}`}
              transition={spring}
              className="absolute inset-0 rounded-md bg-surface shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.06)] dark:bg-white/[0.11] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_1px_2px_rgb(0_0_0/0.3)]"
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">
            {o.icon}
            {o.label}
          </span>
        </button>
      ))}
    </div>
  );
}
