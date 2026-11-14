import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

export const buttonStyles = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap transition-colors duration-(--motion-fast) select-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "border-accent bg-accent text-bg hover:not-disabled:brightness-110",
        secondary: "border-control bg-bg-raised text-fg hover:not-disabled:tint-hover",
        quiet: "border-transparent bg-transparent text-fg hover:not-disabled:tint-hover",
        destructive: "border-destructive bg-destructive text-bg hover:not-disabled:brightness-110",
      },
      size: {
        md: "h-8 px-3 text-ui",
        sm: "h-7 px-2 text-dense",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonStyles> & {
    /** Render the child element (a link, say) with button styles. */
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      data-slot="button"
      type={asChild ? undefined : type}
      className={cn(buttonStyles({ variant, size }), className)}
      {...props}
    />
  );
}
