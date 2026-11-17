import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium outline-none transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:cursor-not-allowed focus-visible:shadow-[0_0_0_1px_var(--surface),0_0_0_3px_var(--focus)] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-inverse text-inverse-fg hover:bg-inverse-hover disabled:opacity-40",
        secondary:
          "border border-line bg-surface text-fg shadow-xs hover:border-line-strong hover:bg-hover disabled:opacity-50",
        ghost: "text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-40",
        subtle: "bg-hover text-fg hover:bg-active disabled:opacity-40",
        danger:
          "border border-line bg-surface text-danger-fg shadow-xs hover:border-[color-mix(in_srgb,var(--danger)_40%,var(--line))] hover:bg-[color-mix(in_srgb,var(--danger)_6%,var(--surface))] disabled:opacity-50",
        "danger-solid": "bg-danger text-white hover:bg-[color-mix(in_srgb,var(--danger)_88%,black)] disabled:opacity-40",
        link: "h-auto px-0 text-fg underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-md px-2.5 text-[12.5px] [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-8 gap-1.5 rounded-md px-3 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 rounded-lg px-4 text-[13.5px] [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

const iconSizes = { xs: "size-6", sm: "size-7", md: "size-8", lg: "size-10" } as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    icon?: ReactNode;
    iconRight?: ReactNode;
    loading?: boolean;
    asChild?: boolean;
    /** Square, icon-only. Pass aria-label. */
    square?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", icon, iconRight, loading, asChild, square, className, children, disabled, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), square && cn(iconSizes[size ?? "sm"], "px-0"), className)}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        // With an icon the spinner takes its place; without one it sits over the
        // hidden label, so the button keeps its width while it loads.
        icon ? (
          <>
            {loading ? <Spinner className="size-3.5" /> : icon}
            {children}
            {iconRight}
          </>
        ) : (
          <>
            <span className={cn("contents", loading && "[&>*]:opacity-0")}>
              <span className="inline-flex min-w-0 items-center gap-[inherit]">{children}</span>
              {iconRight && <span className="inline-flex">{iconRight}</span>}
            </span>
            {loading && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Spinner className="size-3.5" />
              </span>
            )}
          </>
        )
      )}
    </Comp>
  );
});

/** A filter's trigger: what it is set to, with a chevron, outlined darker while it filters. */
export const FilterButton = forwardRef<HTMLButtonElement, { icon: ReactNode; label: ReactNode; active: boolean } & ButtonHTMLAttributes<HTMLButtonElement>>(function FilterButton(
  { icon, label, active, className, ...rest },
  ref,
) {
  return (
    <Button ref={ref} {...rest} icon={icon} iconRight={<ChevronDown className="size-3 text-fg-4" />} className={cn("max-w-[200px]", active && "border-fg-3", className)}>
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  );
});
