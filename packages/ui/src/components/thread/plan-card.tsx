import { ListChecks } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Textarea } from "../field.js";
import { Skeleton } from "../status.js";
import { formatCost, formatCount } from "./format.js";

export type PlanStep = {
  id: string;
  title: string;
  sources: readonly string[];
  estimate: { docs: number; pages: number };
};

/** Nothing runs until a person approves, so cost and scope are seen first. */
export function PlanCard({
  steps,
  costLow,
  costHigh,
  onApprove,
  onEdit,
  onCancel,
  busy = false,
  className,
}: {
  steps: readonly PlanStep[];
  costLow: number;
  costHigh: number;
  onApprove: () => void;
  onEdit: (instruction: string) => void;
  onCancel: () => void;
  busy?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const docs = steps.reduce((sum, step) => sum + step.estimate.docs, 0);
  const pages = steps.reduce((sum, step) => sum + step.estimate.pages, 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (!text) return;
    onEdit(text);
    setInstruction("");
    setEditing(false);
  };

  // Enter on the card approves, as the shortcut table promises; typing in the box doesn't.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (editing || busy || event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onApprove();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <section
      aria-label="Plan awaiting approval"
      aria-busy={busy || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card takes Enter to approve and Escape to cancel
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn("grid gap-3 rounded-lg border border-border bg-bg-raised p-4", className)}
    >
      <header className="flex items-center gap-2">
        <ListChecks aria-hidden className="size-4 text-accent" strokeWidth={1.5} />
        <h3 className="text-section font-semibold">Plan</h3>
        <span className="ml-auto text-caption text-fg-muted tabular-nums">
          {formatCount(docs)} files · {formatCount(pages)} pages · {formatCost(costLow)}–
          {formatCost(costHigh)}
        </span>
      </header>
      <ol className="grid list-decimal gap-1.5 pl-5">
        {steps.map((step) => (
          <li key={step.id} className="text-ui">
            <span className="text-fg">{step.title}</span>
            {step.sources.length > 0 && (
              <span className="block text-caption text-fg-muted">
                {step.sources.join(", ")} · {formatCount(step.estimate.docs)} files
              </span>
            )}
          </li>
        ))}
      </ol>
      {editing ? (
        <form onSubmit={submit} className="grid gap-2">
          <label htmlFor="plan-edit" className="text-dense font-medium">
            What should change?
          </label>
          <Textarea
            id="plan-edit"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Skip the side letters and add a check for change of control."
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !instruction.trim()}>
              Re-plan
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <Button onClick={onApprove} disabled={busy}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </Button>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}

export function PlanCardSkeleton() {
  return (
    <div className="grid gap-3 rounded-lg border border-border p-4" aria-hidden>
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
