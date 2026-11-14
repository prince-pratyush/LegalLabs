import { Tabs as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn("flex h-9 items-end gap-4 border-b border-border", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        "-mb-px h-9 border-b-2 border-transparent px-1 text-ui font-medium text-fg-muted transition-colors duration-(--motion-fast) hover:text-fg disabled:opacity-50 data-[state=active]:border-accent data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content className={cn("pt-3", className)} {...props} />;
}
