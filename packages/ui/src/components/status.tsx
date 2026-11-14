import {
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  Lock,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn.js";

export type Tone =
  | "verified"
  | "flagged"
  | "warning"
  | "failed"
  | "locked"
  | "running"
  | "external";

const TONES: Record<Tone, { text: string; dot: string; icon: LucideIcon }> = {
  verified: { text: "text-verified", dot: "bg-verified", icon: CircleCheck },
  flagged: { text: "text-flagged", dot: "bg-flagged", icon: TriangleAlert },
  warning: { text: "text-warning", dot: "bg-warning", icon: TriangleAlert },
  failed: { text: "text-destructive", dot: "bg-destructive", icon: CircleX },
  locked: { text: "text-locked", dot: "bg-locked", icon: Lock },
  running: { text: "text-accent", dot: "bg-accent animate-pulse-dot", icon: LoaderCircle },
  external: {
    text: "text-external-fg",
    dot: "border-2 border-external-fg bg-transparent",
    icon: CircleDashed,
  },
};

/** A dot is decoration; pair it with a label, since colour alone says nothing to many people. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn("inline-block size-2 shrink-0 rounded-full", TONES[tone].dot, className)}
    />
  );
}

/** Status as icon plus words, never a coloured pill. */
export function StatusText({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  const Icon = TONES[tone].icon;
  return (
    <span
      data-tone={tone}
      className={cn("inline-flex items-center gap-1 font-medium", TONES[tone].text, className)}
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
      {children}
    </span>
  );
}

/** Reserves the space content will take, so nothing jumps when it arrives. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div aria-hidden className={cn("animate-shimmer rounded-md bg-border", className)} {...props} />
  );
}
