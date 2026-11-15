import { locate } from "../edits/anchor.js";
import { hunks } from "../edits/hunks.js";
import { searchText } from "../edits/search.js";
import {
  type ApplyResult,
  type Capabilities,
  capabilitiesOf,
  type Edit,
  type Scope,
  type ScopeText,
  type WordHost,
} from "./host.js";

// Word batches stay small so a long run of edits doesn't stall the host.
const BATCH = 50;
// Word refuses search text over 255 characters, so long text is found by its two ends.
const SEARCH_MAX = 255;
const END = 200;

type Found = { pick: () => Word.Range | null };

/** Queues a search; `pick` is read after the next sync. */
function find(range: Word.Range, text: string, occurrence: number | "only"): Found {
  const options = { matchCase: true };
  const whole = searchText(text);
  if (whole.length <= SEARCH_MAX) {
    const hits = range.search(whole, options);
    hits.load("items");
    return {
      pick: () =>
        occurrence === "only"
          ? hits.items.length === 1
            ? (hits.items[0] ?? null)
            : null
          : (hits.items[occurrence] ?? null),
    };
  }
  const head = range.search(searchText(text.slice(0, END)), options);
  const tail = range.search(searchText(text.slice(-END)), options);
  head.load("items");
  tail.load("items");
  // Unique ends only: anything else could join the wrong two places.
  return {
    pick: () => {
      const [h] = head.items;
      const [t] = tail.items;
      return head.items.length === 1 && tail.items.length === 1 && h && t ? h.expandTo(t) : null;
    },
  };
}

const lines = (text: string) => text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");

async function withTracking<T>(
  context: Word.RequestContext,
  track: boolean,
  work: () => Promise<T>,
): Promise<T> {
  const document = context.document;
  document.load("changeTrackingMode");
  await context.sync();
  const previous = document.changeTrackingMode;
  // Turned on and left on, as a reviewer expects; turned off only for this edit.
  document.changeTrackingMode = track
    ? Word.ChangeTrackingMode.trackAll
    : Word.ChangeTrackingMode.off;
  const result = await work();
  if (!track) document.changeTrackingMode = previous;
  await context.sync();
  return result;
}

async function applyEdit(
  context: Word.RequestContext,
  capabilities: Capabilities,
  edit: Edit,
  track: boolean,
): Promise<ApplyResult> {
  const body = context.document.body;
  const paragraphs = body.paragraphs;
  paragraphs.load("items/text");
  await context.sync();
  const texts = paragraphs.items.map((p) => p.text);
  const where = await locate(texts, edit.anchor, edit.before);
  const paragraph = where.kind === "paragraph" ? paragraphs.items[where.index] : undefined;

  // A missing clause: added as a new paragraph after its anchor.
  if (edit.before === "") {
    if (!paragraph) return { ok: false, reason: "anchor_failed" };
    return withTracking(context, track, async () => {
      const added = paragraph.insertParagraph(edit.after, "After");
      if (edit.comment && capabilities.comments)
        added.getRange("Whole").insertComment(edit.comment);
      return { ok: true } as const;
    });
  }

  const target = find(
    paragraph ? paragraph.getRange("Whole") : body.getRange("Whole"),
    edit.before,
    paragraph ? 0 : "only",
  );
  await context.sync();
  const range = target.pick();
  if (!range) return { ok: false, reason: "anchor_failed" };

  const changes = hunks(edit.before, edit.after);
  const found = changes.map((h) =>
    h.occurrence === null ? null : find(range, edit.before.slice(h.from, h.to), h.occurrence),
  );
  await context.sync();
  const ranges = found.map((f) => f?.pick() ?? null);

  return withTracking(context, track, async () => {
    // First, so the comment spans the whole clause and survives the edits inside it.
    if (edit.comment && capabilities.comments) range.insertComment(edit.comment);
    if (ranges.every((r) => r !== null)) {
      for (const [i, r] of ranges.entries()) {
        const insert = changes[i]?.insert ?? "";
        if (insert) r.insertText(insert, "Replace");
        else r.delete();
      }
    } else {
      // Some piece couldn't be found on its own: replace the clause as a whole instead.
      range.insertText(edit.after, "Replace");
    }
    return { ok: true } as const;
  });
}

function readFile(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    Office.context.document.getFileAsync(
      Office.FileType.Compressed,
      { sliceSize: 4 * 1024 * 1024 },
      (opened) => {
        if (opened.status !== Office.AsyncResultStatus.Succeeded) {
          reject(new Error(opened.error.message));
          return;
        }
        const file = opened.value;
        const parts: Uint8Array[] = [];
        const next = (index: number) => {
          if (index === file.sliceCount) {
            file.closeAsync();
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const part of parts) {
              out.set(part, at);
              at += part.length;
            }
            resolve(out);
            return;
          }
          file.getSliceAsync(index, (slice) => {
            if (slice.status !== Office.AsyncResultStatus.Succeeded) {
              file.closeAsync();
              reject(new Error(slice.error.message));
              return;
            }
            parts.push(new Uint8Array(slice.value.data as number[]));
            next(index + 1);
          });
        };
        next(0);
      },
    );
  });
}

/** The real thing: Office.js against the open document. */
export function createWordHost(): WordHost {
  const capabilities = capabilitiesOf((name, version) =>
    Office.context.requirements.isSetSupported(name, version),
  );

  return {
    capabilities,

    read: (scope: Scope) =>
      Word.run(async (context): Promise<ScopeText> => {
        if (scope === "document") {
          const paragraphs = context.document.body.paragraphs;
          paragraphs.load("items/text");
          await context.sync();
          const texts = paragraphs.items.map((p) => p.text);
          return { text: texts.join("\n"), paragraphs: texts };
        }
        const selection = context.document.getSelection();
        selection.load("text");
        const paragraphs = selection.paragraphs;
        paragraphs.load("items/text");
        await context.sync();
        return {
          text: lines(selection.text).join("\n"),
          paragraphs: paragraphs.items.map((p) => p.text),
        };
      }),

    file: readFile,

    title: () => {
      const url = Office.context.document.url ?? "";
      const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? "").replace(/\.docx?$/i, "");
      return name || "Word document";
    },

    select: (text) =>
      Word.run(async (context) => {
        const first = lines(text)[0] ?? "";
        if (!first) return false;
        const hit = find(context.document.body.getRange("Whole"), first, 0);
        await context.sync();
        const range = hit.pick();
        if (!range) return false;
        range.select("Select");
        await context.sync();
        return true;
      }),

    apply: (edit, track) =>
      capabilities.tracked
        ? Word.run((context) => applyEdit(context, capabilities, edit, track))
        : Promise.resolve({ ok: false, reason: "unsupported" }),

    rewrite: (scope, edits, track) =>
      Word.run(async (context) => {
        const paragraphs =
          scope === "document"
            ? context.document.body.paragraphs
            : context.document.getSelection().paragraphs;
        paragraphs.load("items/text");
        await context.sync();
        return withTracking(context, track, async () => {
          let changed = 0;
          for (const [i, edit] of edits.entries()) {
            const paragraph = paragraphs.items[edit.index];
            if (!paragraph || paragraph.text === edit.text) continue;
            paragraph.insertText(edit.text, "Replace");
            changed++;
            if ((i + 1) % BATCH === 0) await context.sync();
          }
          return changed;
        });
      }),

    onSelectionChange(listener) {
      const handler = () => listener();
      Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, handler);
      return () =>
        Office.context.document.removeHandlerAsync(Office.EventType.DocumentSelectionChanged, {
          handler,
        });
    },

    openInBrowser(url) {
      try {
        Office.context.ui.openBrowserWindow(url);
      } catch {
        // Hosts without OpenBrowserWindowApi still have a browser window to open.
        window.open(url, "_blank", "noopener");
      }
    },
  };
}
