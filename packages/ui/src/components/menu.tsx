import { DropdownMenu as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";
import { Kbd } from "./tooltip.js";

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;
export const MenuGroup = Primitive.Group;

export function MenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-48 rounded-md border border-border bg-bg-raised p-1 text-ui text-fg shadow-lg data-[state=open]:animate-pop-in",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function MenuItem({
  className,
  shortcut,
  destructive,
  children,
  ...props
}: ComponentProps<typeof Primitive.Item> & { shortcut?: string; destructive?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        "flex h-8 cursor-default items-center gap-2 rounded-sm px-2 -outline-offset-2 select-none data-disabled:opacity-50 data-highlighted:tint-selected [&_svg]:size-4",
        destructive && "text-destructive",
        className,
      )}
      {...props}
    >
      {children}
      {shortcut && <Kbd className="ml-auto">{shortcut}</Kbd>}
    </Primitive.Item>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("px-2 py-1 text-caption font-medium text-fg-muted", className)}
      {...props}
    />
  );
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
