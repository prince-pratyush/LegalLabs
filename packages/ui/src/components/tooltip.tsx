import { Tooltip as Primitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn.js";

// 150 ms matches the citation popover, so every hint appears at the same pace.
export function TooltipProvider(props: ComponentProps<typeof Primitive.Provider>) {
  return <Primitive.Provider delayDuration={150} {...props} />;
}

export const tooltipSurface =
  "z-50 rounded-md border border-border bg-bg-raised text-fg shadow-lg data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-pop-in";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "rounded-sm border border-border bg-bg-subtle px-1 font-sans text-caption text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

/** Shortcuts are listed in every tooltip, so they can be learned in passing. */
export function Tooltip({
  content,
  shortcut,
  children,
  ...props
}: Omit<ComponentProps<typeof Primitive.Root>, "children"> & {
  content: ReactNode;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <Primitive.Root {...props}>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            sideOffset={6}
            className={cn(tooltipSurface, "flex items-center gap-2 px-2 py-1 text-caption")}
          >
            {content}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </TooltipProvider>
  );
}
