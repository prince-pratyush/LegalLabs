import { Bot, X } from "lucide-react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";

/** A one-line suggestion above the composer; it never runs anything by itself. */
export function NudgeChip({
  title,
  onRun,
  onDismiss,
  className,
}: {
  title: string;
  onRun: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <aside
      aria-label="Suggested agent"
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-bg-raised px-3 py-1.5",
        className,
      )}
    >
      <Bot aria-hidden className="size-4 shrink-0 text-accent" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate text-dense">
        Shared agent “{title}” matches this request.
      </span>
      <Button size="sm" variant="secondary" onClick={onRun}>
        Run {title}?
      </Button>
      <Button size="icon" variant="quiet" aria-label="Dismiss suggestion" onClick={onDismiss}>
        <X aria-hidden />
      </Button>
    </aside>
  );
}
