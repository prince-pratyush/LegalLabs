import { AlertDialog as Primitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button.js";

/** The kit's only modal, so dialogs never stack; everything else is a side panel. */
export function ConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Primitive.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger && <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>}
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-fg/40 data-[state=open]:animate-fade-in" />
        <Primitive.Content className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-1/2 gap-3 rounded-lg border border-border bg-bg-raised p-6 text-fg shadow-xl data-[state=open]:animate-fade-in">
          <Primitive.Title className="text-section font-semibold">{title}</Primitive.Title>
          <Primitive.Description className="text-ui text-fg-muted">
            {description}
          </Primitive.Description>
          <div className="mt-2 flex justify-end gap-2">
            <Primitive.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </Primitive.Cancel>
            <Primitive.Action asChild>
              <Button variant={destructive ? "destructive" : "primary"} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
