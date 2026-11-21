import { MessageCircleQuestion } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Label, Textarea } from "../field.js";

export type QuestionAnswer = { option_id: string } | { text: string } | { skip: true };

/**
 * A run waiting on a person. Inline, never a modal: digits pick an option, Enter sends the
 * text, S skips, so answering never needs the mouse.
 */
export function QuestionCard({
  text,
  options,
  allowText,
  allowSkip,
  skipLabel = "Skip",
  busy = false,
  error,
  onAnswer,
  className,
}: {
  text: string;
  options: readonly { id: string; label: string }[];
  allowText: boolean;
  allowSkip: boolean;
  /** The builder says "Skip remaining", since a skip there ends the questions. */
  skipLabel?: string;
  busy?: boolean;
  error?: string | null;
  onAnswer: (answer: QuestionAnswer) => void;
  className?: string;
}) {
  const id = useId();
  const [reply, setReply] = useState("");
  const shown = options.slice(0, 5);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = reply.trim();
    if (!value || busy) return;
    onAnswer({ text: value });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || event.target instanceof HTMLTextAreaElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const n = Number(event.key);
    const option = Number.isInteger(n) && n >= 1 ? shown[n - 1] : undefined;
    if (option) {
      event.preventDefault();
      onAnswer({ option_id: option.id });
    } else if (allowSkip && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onAnswer({ skip: true });
    }
  };

  return (
    <section
      aria-labelledby={`${id}-q`}
      aria-busy={busy || undefined}
      onKeyDown={onKeyDown}
      className={cn("grid gap-3 rounded-lg border border-border bg-bg-raised p-4", className)}
    >
      <p id={`${id}-q`} className="flex items-start gap-2 text-ui font-medium text-fg">
        <MessageCircleQuestion
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-accent"
          strokeWidth={1.5}
        />
        {text}
      </p>
      {shown.length > 0 && (
        <ul aria-label="Suggested answers" className="flex flex-wrap gap-2">
          {shown.map((option, i) => (
            <li key={option.id}>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => onAnswer({ option_id: option.id })}
              >
                <span aria-hidden className="text-fg-muted tabular-nums">
                  {i + 1}
                </span>
                {option.label}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {allowText && (
        <form onSubmit={submit} className="grid gap-2">
          <Label htmlFor={`${id}-text`} className="text-dense">
            Your answer
          </Label>
          <Textarea
            id={`${id}-text`}
            value={reply}
            disabled={busy}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            className="min-h-12"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || !reply.trim()}>
              Send
            </Button>
            {allowSkip && (
              <Button
                size="sm"
                variant="quiet"
                disabled={busy}
                aria-keyshortcuts="S"
                onClick={() => onAnswer({ skip: true })}
              >
                {skipLabel}
              </Button>
            )}
          </div>
        </form>
      )}
      {!allowText && allowSkip && (
        <div>
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            aria-keyshortcuts="S"
            onClick={() => onAnswer({ skip: true })}
          >
            {skipLabel}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
