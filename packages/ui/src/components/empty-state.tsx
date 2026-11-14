import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn.js";
import { Button } from "./button.js";

type Action = { label: string; onClick: () => void };

/** The action is required, so no empty or error state is a dead end. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondary,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action: Action;
  secondary?: Action;
  className?: string;
}) {
  return (
    <div className={cn("grid justify-items-center gap-2 px-6 py-12 text-center", className)}>
      {Icon && <Icon aria-hidden className="size-6 text-fg-muted" strokeWidth={1.5} />}
      <p className="text-section font-semibold text-fg">{title}</p>
      {description && <p className="max-w-prose text-ui text-fg-muted">{description}</p>}
      <div className="mt-2 flex gap-2">
        <Button onClick={action.onClick}>{action.label}</Button>
        {secondary && (
          <Button variant="quiet" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
      </div>
    </div>
  );
}
