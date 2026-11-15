import { locate } from "../edits/anchor.js";
import type { Capabilities, Edit, Scope, WordHost } from "../office/host.js";

/** Word as a list of paragraphs, so the pane's logic runs without Office. */
export function fakeHost(
  paragraphs: string[],
  capabilities: Capabilities = { tracked: true, comments: true },
) {
  const log = {
    applied: [] as { edit: Edit; track: boolean }[],
    rewrites: [] as { scope: Scope; edits: { index: number; text: string }[]; track: boolean }[],
    selected: [] as string[],
    opened: [] as string[],
  };
  let selection = "";
  const host: WordHost = {
    capabilities,
    read: async (scope) =>
      scope === "document"
        ? { text: paragraphs.join("\n"), paragraphs: [...paragraphs] }
        : {
            text: selection,
            paragraphs: paragraphs.filter((p) => selection && p.includes(selection)),
          },
    file: async () => new Uint8Array([80, 75, 3, 4]),
    title: () => "Sample NDA",
    select: async (text) => {
      log.selected.push(text);
      return paragraphs.some((p) => p.includes(text));
    },
    apply: async (edit, track) => {
      if (!capabilities.tracked) return { ok: false, reason: "unsupported" };
      const where = await locate(paragraphs, edit.anchor, edit.before);
      const index =
        where.kind === "paragraph"
          ? where.index
          : paragraphs.filter((p) => p.includes(edit.before)).length === 1
            ? paragraphs.findIndex((p) => p.includes(edit.before))
            : -1;
      const text = paragraphs[index];
      if (text === undefined) return { ok: false, reason: "anchor_failed" };
      paragraphs[index] = text.replace(edit.before, edit.after);
      log.applied.push({ edit, track });
      return { ok: true };
    },
    rewrite: async (scope, edits, track) => {
      log.rewrites.push({ scope, edits: [...edits], track });
      return edits.length;
    },
    onSelectionChange: () => () => {},
    openInBrowser: (url) => void log.opened.push(url),
  };
  return {
    host,
    log,
    paragraphs,
    select: (text: string) => {
      selection = text;
    },
  };
}
