import { Check, ChevronDown } from "lucide-react";
import { Select as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

export const Select = Primitive.Root;
export const SelectValue = Primitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        "inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-control bg-bg-raised px-3 text-ui text-fg disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-fg-muted",
        className,
      )}
      {...props}
    >
      {children}
      <Primitive.Icon asChild>
        <ChevronDown aria-hidden className="size-4 text-fg-muted" />
      </Primitive.Icon>
    </Primitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          "z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-y-auto rounded-md border border-border bg-bg-raised p-1 text-ui text-fg shadow-lg data-[state=open]:animate-pop-in",
          className,
        )}
        {...props}
      >
        <Primitive.Viewport>{children}</Primitive.Viewport>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "relative flex h-8 cursor-default items-center rounded-sm pr-8 pl-2 -outline-offset-2 select-none data-disabled:opacity-50 data-highlighted:tint-selected",
        className,
      )}
      {...props}
    >
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator className="absolute right-2">
        <Check aria-hidden className="size-4" />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
