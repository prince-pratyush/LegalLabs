import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { cn } from "../cn.js";
import { Button } from "./button.js";
import { Tooltip } from "./tooltip.js";

export const PANEL_MIN = 360;
export const PANEL_MAX = 560;
const STEP = 16;

export const clampWidth = (width: number, min = PANEL_MIN, max = PANEL_MAX) =>
  Math.min(max, Math.max(min, Math.round(width)));

/** A drag handle that also works from the keyboard, since no action may be drag-only. */
export function ResizeHandle({
  value,
  onChange,
  label,
  min = PANEL_MIN,
  max = PANEL_MAX,
  className,
}: {
  value: number;
  onChange: (width: number) => void;
  label: string;
  min?: number;
  max?: number;
  className?: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    const next: Record<string, number> = {
      ArrowLeft: value + STEP,
      ArrowRight: value - STEP,
      Home: min,
      End: max,
    };
    const width = next[event.key];
    if (width === undefined) return;
    event.preventDefault();
    onChange(clampWidth(width, min, max));
  };

  // The panel sits on the right, so dragging left widens it.
  const onPointerMove = (event: PointerEvent) => {
    if (!start.current) return;
    onChange(clampWidth(start.current.width - (event.clientX - start.current.x), min, max));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an hr can't take focus or be dragged
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: value };
      }}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        start.current = null;
      }}
      className={cn(
        "group absolute inset-y-0 -left-1 z-10 flex w-2 cursor-col-resize justify-center touch-none",
        className,
      )}
    >
      <span className="w-px bg-border transition-colors duration-(--motion-fast) group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  );
}

/**
 * Everything that isn't a confirmation opens here instead of in a modal. It is a
 * non-modal dialog: Esc closes it and focus goes back to what opened it.
 */
export function SidePanel({
  title,
  onClose,
  width,
  onWidthChange,
  children,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  width: number;
  onWidthChange?: (width: number) => void;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    if (!ref.current?.contains(opener)) ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
      style={{ width: clampWidth(width) }}
      className={cn(
        "relative flex h-full max-w-full flex-col border-l border-border bg-bg-subtle text-fg data-[motion=on]:animate-slide-in",
        className,
      )}
    >
      {onWidthChange && (
        <ResizeHandle value={clampWidth(width)} onChange={onWidthChange} label="Resize panel" />
      )}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 id={titleId} className="truncate text-section font-semibold">
          {title}
        </h2>
        <Tooltip content="Close panel" shortcut="Esc">
          <Button variant="quiet" size="icon" aria-label="Close panel" onClick={onClose}>
            <X aria-hidden />
          </Button>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}
