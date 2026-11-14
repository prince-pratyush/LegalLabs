import { Toaster as Sonner, toast } from "sonner";

export { toast };

/** Mount once. Toasts are announced politely and never steal focus. */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-80 items-start gap-2 rounded-md border border-border bg-bg-raised p-3 text-ui text-fg shadow-lg",
          title: "font-medium",
          description: "text-fg-muted",
          actionButton:
            "ml-auto h-7 rounded-md border border-accent bg-accent px-2 text-dense font-medium text-bg",
          cancelButton: "h-7 rounded-md px-2 text-dense",
          success: "[&_[data-icon]]:text-verified",
          error: "[&_[data-icon]]:text-destructive",
          warning: "[&_[data-icon]]:text-warning",
        },
      }}
    />
  );
}
