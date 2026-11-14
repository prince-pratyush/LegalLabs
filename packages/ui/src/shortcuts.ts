import { useEffect, useRef } from "react";

/** The global and thread keys from the keyboard map; shown in the `?` help. */
export const KEYMAP = [
  { scope: "Global", keys: "mod+k", label: "Open the command palette" },
  { scope: "Global", keys: "mod+shift+o", label: "New thread" },
  { scope: "Global", keys: "mod+b", label: "Show or hide the sidebar" },
  { scope: "Global", keys: "mod+/", label: "Show or hide the context panel" },
  { scope: "Global", keys: "mod+\\", label: "Split view" },
  { scope: "Global", keys: "mod+.", label: "Stop the run" },
  { scope: "Global", keys: "?", label: "Show shortcuts" },
  { scope: "Global", keys: "Escape", label: "Close the topmost panel" },
  { scope: "Global", keys: "g t", label: "Go to Threads" },
  { scope: "Global", keys: "g a", label: "Go to Agents" },
  { scope: "Global", keys: "g r", label: "Go to Review tables" },
  { scope: "Global", keys: "g v", label: "Go to Vaults" },
  { scope: "Global", keys: "g s", label: "Go to Spaces" },
  { scope: "Global", keys: "g l", label: "Go to Library" },
  { scope: "Global", keys: "g h", label: "Go to History" },
  { scope: "Global", keys: "g n", label: "Go to Notifications" },
  { scope: "Thread", keys: "Enter", label: "Send" },
  { scope: "Thread", keys: "shift+Enter", label: "New line" },
  { scope: "Thread", keys: "[", label: "Previous citation" },
  { scope: "Thread", keys: "]", label: "Next citation" },
] as const;

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether one chord like "mod+shift+o" or "?" matches a key press. */
export function matchesChord(chord: string, event: KeyLike): boolean {
  const parts = chord.toLowerCase().split("+");
  const key = parts.pop();
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  if (mod !== (event.metaKey || event.ctrlKey) || event.altKey) return false;
  // Shift is part of the key itself for symbols like "?", so only check it for letters.
  if (/^[a-z]$/.test(key ?? "") && shift !== event.shiftKey) return false;
  return event.key.toLowerCase() === key;
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function formatKeys(keys: string, mac = isMac()): string {
  return keys
    .split(" ")
    .map((chord) =>
      chord
        .split("+")
        .map((part) =>
          part === "mod"
            ? mac
              ? "⌘"
              : "Ctrl"
            : part === "shift"
              ? mac
                ? "⇧"
                : "Shift"
              : part.length === 1
                ? part.toUpperCase()
                : part,
        )
        .join(mac ? "" : "+"),
    )
    .join(" then ");
}

/**
 * Binds keys like "mod+k", "?" or the sequence "g t". Keys without a modifier are
 * ignored while typing, so they never steal a letter from a text field.
 */
export function useHotkeys(bindings: Record<string, () => void>, enabled = true) {
  const latest = useRef(bindings);
  latest.current = bindings;

  useEffect(() => {
    if (!enabled) return;
    let pending: { key: string; at: number } | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = editable(event.target);
      for (const [keys, run] of Object.entries(latest.current)) {
        const chords = keys.split(" ");
        const last = chords.at(-1) ?? "";
        const plain = !last.includes("mod+");
        if (plain && typing) continue;
        if (!matchesChord(last, event)) continue;
        if (chords.length === 2) {
          const first = chords[0] ?? "";
          if (!pending || pending.key !== first || event.timeStamp - pending.at > 1000) continue;
        }
        event.preventDefault();
        pending = null;
        run();
        return;
      }
      pending = typing ? null : { key: event.key.toLowerCase(), at: event.timeStamp };
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
