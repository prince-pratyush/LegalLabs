import { CalendarClock, KeyRound } from "lucide-react";
import { cn } from "../../cn.js";
import { StatusText } from "../status.js";
import { ACCESS_LABEL, type AccessLevel } from "./types.js";

/** What the viewer may do with an agent, so a missing button is never a mystery. */
export function AccessBadge({ level, className }: { level: AccessLevel; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-caption text-fg-muted",
        className,
      )}
    >
      <KeyRound aria-hidden className="size-3" strokeWidth={1.5} />
      {ACCESS_LABEL[level]}
    </span>
  );
}

/** Draft means nothing runs yet; live means Run uses the saved version. */
export function AgentStatusBadge({ status }: { status: "draft" | "live" }) {
  return status === "live" ? (
    <StatusText tone="verified" className="text-caption">
      Live
    </StatusText>
  ) : (
    <StatusText tone="warning" className="text-caption">
      Draft
    </StatusText>
  );
}

export function ScheduleBadge({ paused }: { paused: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-caption text-fg-muted">
      <CalendarClock aria-hidden className="size-3" strokeWidth={1.5} />
      {paused ? "Schedule paused" : "Scheduled"}
    </span>
  );
}
