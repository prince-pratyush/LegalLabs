import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../cn.js";

const control =
  "w-full rounded-md border border-control bg-bg-raised px-3 text-ui text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn(control, "h-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(control, "min-h-20 resize-y py-2", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or nest the control
  return <label className={cn("text-ui font-medium text-fg", className)} {...props} />;
}

export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

/** A labelled control with optional hint and error, wired for screen readers. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid gap-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {hint && (
        <p id={hintId} className="text-caption text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
