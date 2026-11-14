import { ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../cn.js";
import { Button } from "./button.js";
import { StatusText, type Tone } from "./status.js";

export type UploadState =
  | "waiting"
  | "uploading"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "rejected";

export interface UploadItem {
  id: string;
  name: string;
  state: UploadState;
  /** 0 to 1 while uploading. */
  progress?: number;
  /** Why a file failed or was refused, in plain words. */
  message?: string;
}

const STATES: Record<UploadState, { tone: Tone; label: string }> = {
  waiting: { tone: "external", label: "Waiting" },
  uploading: { tone: "running", label: "Uploading" },
  queued: { tone: "external", label: "Queued" },
  processing: { tone: "running", label: "Reading" },
  ready: { tone: "verified", label: "Ready" },
  failed: { tone: "failed", label: "Failed" },
  rejected: { tone: "warning", label: "Not uploaded" },
};

// Words with the icon: colour alone says nothing to many people.
export function FileStateText({ state, progress }: { state: UploadState; progress?: number }) {
  const { tone, label } = STATES[state];
  const percent =
    state === "uploading" && progress !== undefined ? ` ${Math.round(progress * 100)}%` : "";
  return (
    <StatusText tone={tone}>
      {label}
      {percent}
    </StatusText>
  );
}

const done = (state: UploadState) =>
  state === "ready" || state === "failed" || state === "rejected";
const troubled = (state: UploadState) => state === "failed" || state === "rejected";

/**
 * Docked bottom-right while files upload and are read; it stays as people move around,
 * because reading carries on in the background.
 */
export function UploadTray({
  items,
  onRetry,
  onClose,
  className,
}: {
  items: readonly UploadItem[];
  onRetry?: (id: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const ready = items.filter((item) => item.state === "ready").length;
  const failed = items.filter((item) => troubled(item.state)).length;
  const finished = items.every((item) => done(item.state));
  const shown = onlyFailed ? items.filter((item) => troubled(item.state)) : items;
  const summary = `${ready} of ${items.length} ready${failed ? ` · ${failed} failed` : ""}`;

  return (
    <section
      aria-label="Uploads"
      className={cn(
        "flex w-[360px] max-w-full flex-col rounded-md border border-border bg-bg-raised shadow-lg",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p aria-live="polite" className="flex-1 text-ui font-medium">
          {finished ? summary : `Uploading · ${summary}`}
        </p>
        <Button
          variant="quiet"
          size="icon"
          aria-label={collapsed ? "Show uploads" : "Hide uploads"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </Button>
        <Button variant="quiet" size="icon" aria-label="Close uploads" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>
      {!collapsed && (
        <>
          {failed > 0 && (
            <div className="border-b border-border px-3 py-1">
              <Button variant="quiet" size="sm" onClick={() => setOnlyFailed(!onlyFailed)}>
                {onlyFailed ? "Show all" : "Show failed"}
              </Button>
            </div>
          )}
          <ul className="max-h-72 overflow-auto py-1">
            {shown.map((item) => (
              <li key={item.id} className="grid gap-0.5 px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui" title={item.name}>
                    {item.name}
                  </span>
                  <FileStateText
                    state={item.state}
                    {...(item.progress === undefined ? {} : { progress: item.progress })}
                  />
                  {item.state === "failed" && onRetry && (
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label={`Retry ${item.name}`}
                      onClick={() => onRetry(item.id)}
                    >
                      <RotateCcw aria-hidden />
                    </Button>
                  )}
                </div>
                {item.message && troubled(item.state) && (
                  <p className="text-caption text-fg-muted">{item.message}</p>
                )}
                {item.state === "uploading" && (
                  <div
                    role="progressbar"
                    aria-label={`Uploading ${item.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((item.progress ?? 0) * 100)}
                    className="h-1 overflow-hidden rounded-full bg-border"
                  >
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
