// Reviews one contract with a starter playbook and writes the outcome as JSON.
// Usage: node node/run.ts --contract <file.docx> --template nda|msa --client fake|ollama|...
//   [--model M] [--parallelism 1] [--rule-timeout-ms 60000] [--call-timeout-ms 300000]
//   [--num-ctx 8192] [--out outcome.json]
// SOFFICE_TEST=1 also converts the fully patched contract to PDF with LibreOffice.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  estimatePages,
  normaliseParagraph,
  type Rule,
  starterPlaybook,
} from "@legallabs/contracts";
import { type PatchEdit, type PatchFailureCode, patchDocx, readDocx } from "@legallabs/docx";
import { type ReviewOutcome, runReview } from "@legallabs/review";
import { PARTIES, type Template } from "./clauses.ts";
import { CLIENTS, type ClientName, type Complete, makeClient } from "./clients.ts";

export type RunOptions = {
  template: Template;
  complete: Complete;
  model: string;
  parallelism?: number;
  ruleTimeoutMs?: number;
  soffice?: string | null;
  log?: (line: string) => void;
};

export type OoxmlCheck = {
  suggestions: number;
  /** Patched one at a time; each must re-read and show its `after` text. */
  applied: number;
  valid: number;
  failed: Partial<Record<PatchFailureCode | "REREAD_FAILED", number>>;
  /** Every suggestion in one file, as a redline download would be. */
  combined: { applied: number; reread_ok: boolean; soffice_ok: boolean | null };
};

export type RunResult = {
  template: Template;
  model: string;
  wall_ms: number;
  chars: number;
  pages: number;
  paragraphs: number;
  existing_edits: number;
  outcome: ReviewOutcome;
  ooxml: OoxmlCheck;
};

const AUTHOR = "LegalLabs";
const DATE = "2026-11-15T00:00:00Z";
const squash = (text: string) => normaliseParagraph(text).replace(/\s+/g, " ");

/** Patch suggestions into the original file and prove Word-compatible output reads back. */
export function checkOoxml(
  bytes: Uint8Array,
  outcome: ReviewOutcome,
  soffice: string | null = null,
): OoxmlCheck {
  const edits: PatchEdit[] = outcome.results.flatMap((f) =>
    f.suggestion
      ? [
          {
            id: f.suggestion.id,
            kind: f.suggestion.kind,
            paragraph_index: f.suggestion.anchor.paragraph_index,
            before: f.suggestion.before,
            after: f.suggestion.after,
            comment: `${f.rule_title}: ${f.suggestion.justification}`,
          },
        ]
      : [],
  );
  const failed: OoxmlCheck["failed"] = {};
  const bump = (code: keyof OoxmlCheck["failed"]) => {
    failed[code] = (failed[code] ?? 0) + 1;
  };
  let applied = 0;
  let valid = 0;
  for (const edit of edits) {
    let result: ReturnType<typeof patchDocx>;
    try {
      result = patchDocx(bytes, [edit], { author: AUTHOR, date: DATE });
    } catch {
      bump("OOXML_INVALID");
      continue;
    }
    const miss = result.failed[0];
    if (miss) {
      bump(miss.code);
      continue;
    }
    applied++;
    try {
      const read = readDocx(result.bytes);
      const at = edit.kind === "insert_after" ? edit.paragraph_index + 1 : edit.paragraph_index;
      const text = read.paragraphs[at]?.text ?? "";
      if (squash(text).includes(squash(edit.after))) valid++;
      else bump("REREAD_FAILED");
    } catch {
      bump("REREAD_FAILED");
    }
  }

  const all = edits.length ? patchDocx(bytes, edits, { author: AUTHOR, date: DATE }) : null;
  let rereadOk = true;
  try {
    if (all) readDocx(all.bytes);
  } catch {
    rereadOk = false;
  }
  let sofficeOk: boolean | null = null;
  if (soffice && all) {
    const dir = mkdtempSync(join(tmpdir(), "playbook-ooxml-"));
    try {
      writeFileSync(join(dir, "patched.docx"), all.bytes);
      execFileSync(
        soffice,
        [
          `-env:UserInstallation=file://${join(dir, "profile")}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          dir,
          join(dir, "patched.docx"),
        ],
        { timeout: 240_000, stdio: "pipe" },
      );
      sofficeOk = existsSync(join(dir, "patched.pdf"));
    } catch {
      sofficeOk = false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    suggestions: edits.length,
    applied,
    valid,
    failed,
    combined: { applied: all?.applied.length ?? 0, reread_ok: rereadOk, soffice_ok: sofficeOk },
  };
}

export async function reviewContract(bytes: Uint8Array, opts: RunOptions): Promise<RunResult> {
  const read = readDocx(bytes);
  const playbook = starterPlaybook(opts.template);
  const rules: Rule[] = (playbook.rules ?? []).map((r, ordinal) => ({
    ...r,
    id: randomUUID(),
    ordinal,
    fallbacks: r.fallbacks ?? [],
    flag: r.flag ?? false,
    actions: r.actions ?? [],
  }));
  const started = performance.now();
  const outcome = await runReview(
    {
      paragraphs: read.paragraphs.map((p) => ({
        index: p.index,
        text: p.text,
        ...(p.section_path ? { section_path: p.section_path } : {}),
        excluded: p.excluded,
        para_hash: p.para_hash,
      })),
      existingEdits: read.existingEdits.map((e) => ({
        paragraph_index: e.paragraph_index,
        kind: e.kind,
        text: e.text,
        author: e.author,
      })),
      rules,
      ...(playbook.guidance ? { guidance: playbook.guidance } : {}),
      customisation: {
        party: opts.template === "msa" ? `${PARTIES.us} (Customer)` : PARTIES.us,
        paper: "theirs",
        mode: "standard",
        scope: "all",
      },
    },
    {
      complete: opts.complete,
      parallelism: opts.parallelism ?? 2,
      ruleTimeoutMs: opts.ruleTimeoutMs ?? 60_000,
      onEvent: (e) => opts.log?.(`${((performance.now() - started) / 1000).toFixed(1)}s ${e.type}`),
    },
  );
  const wall_ms = Math.round(performance.now() - started);
  return {
    template: opts.template,
    model: opts.model,
    wall_ms,
    chars: read.charCount,
    pages: estimatePages(read.charCount),
    paragraphs: read.paragraphs.length,
    existing_edits: read.existingEdits.length,
    outcome,
    ooxml: checkOoxml(bytes, outcome, opts.soffice ?? null),
  };
}

function findSoffice(): string | null {
  if (process.env.SOFFICE_TEST !== "1") return null;
  try {
    return execFileSync("which", ["soffice"]).toString().trim() || null;
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      contract: { type: "string" },
      template: { type: "string" },
      client: { type: "string", default: "fake" },
      model: { type: "string" },
      parallelism: { type: "string", default: "2" },
      "rule-timeout-ms": { type: "string", default: "60000" },
      "call-timeout-ms": { type: "string", default: "300000" },
      "num-ctx": { type: "string", default: "8192" },
      out: { type: "string" },
    },
  });
  const template = values.template as Template;
  const client = values.client as ClientName;
  if (!values.contract || !["nda", "msa"].includes(template) || !CLIENTS.includes(client)) {
    console.error(
      `usage: node node/run.ts --contract <file.docx> --template nda|msa --client ${CLIENTS.join("|")}`,
    );
    process.exit(2);
  }
  const { complete, model } = makeClient({
    client,
    model: values.model,
    callTimeoutMs: Number(values["call-timeout-ms"]),
    numCtx: Number(values["num-ctx"]),
  });
  const result = await reviewContract(readFileSync(values.contract), {
    template,
    complete,
    model,
    parallelism: Number(values.parallelism),
    ruleTimeoutMs: Number(values["rule-timeout-ms"]),
    soffice: findSoffice(),
    log: (line) => console.error(line),
  });
  const json = `${JSON.stringify(result)}\n`;
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);
}
