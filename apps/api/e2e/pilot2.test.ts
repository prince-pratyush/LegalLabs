import type { Finding, Review, Suggestion } from "@legallabs/contracts";
import * as contracts from "@legallabs/contracts";
import { buildDocx, markdownBlocks, patchDocx, readDocx } from "@legallabs/docx";
import { sampleFirmTemplate } from "@legallabs/docx/testing";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { sofficeValidator } from "../src/reviews/soffice.js";
// @ts-expect-error: a plain script, shared with the stack.
import { GAP_SCRIPT, PLAYBOOK_SCRIPT } from "./model.mjs";
import { until, useStack } from "./session.js";

type Step = { title: string; status: string; before: string; after?: string };
const SCRIPT = PLAYBOOK_SCRIPT as Step[];
const step = (title: string) => {
  const found = SCRIPT.find((s) => s.title === title);
  if (!found) throw new Error(`the model script has no rule ${title}`);
  return found as Step & { after: string };
};
const LIABILITY = step("Limitation of Liability Cap");
const PAYMENT = step("Payment Terms");
const PRICE = step("Price Increases");
const CONVENIENCE = step("Termination for Convenience");
const LAW = step("Governing Law and Jurisdiction");
const CONFIDENTIALITY = step("Confidentiality and Publicity");
const NOT_ACCEPTABLE = SCRIPT.filter((s) => s.status === "not_acceptable").map((s) => s.title);
// Three applied (two with a comment) and two dismissed.
const APPLY = [
  { step: LIABILITY, comment: true },
  { step: CONVENIENCE, comment: false },
  { step: LAW, comment: true },
];
const DISMISS = [PAYMENT, PRICE];

// Review-table routes and contracts land together in the review-tables PR (branch
// feat/review-tables); its contract export is what turns the step on. Once on, a 404 fails.
const TABLES_LIVE = "CreateTableBody" in contracts;

const contract = (days: number, law: string) => `MASTER SERVICES AGREEMENT

12. Liability
12.1 The Supplier's aggregate liability shall not exceed the fees paid in the twelve months before the claim.

13. Termination
13.1 Either party may terminate this agreement on ${days} days written notice.

14. Governing law
14.1 This agreement is governed by the laws of ${law}.
`;
const CONTRACTS = [
  { name: "msa-england.txt", text: contract(90, "England and Wales"), law: "england", days: "90" },
  { name: "msa-new-york.txt", text: contract(30, "New York"), law: "new_york", days: "30" },
];

// The MSA under review: five clauses the playbook forbids, one it accepts, one no rule covers.
const MSA = `# Master Services Agreement

## 1. Services

The Supplier shall provide the hosted contract management services described in each order form.

## 2. Fees

Fees are payable ${PAYMENT.before}.

The Supplier may increase the fees ${PRICE.before}.

## 3. Liability

${LIABILITY.before}.

## 4. Term

${CONVENIENCE.before}.

## 5. Confidentiality

${CONFIDENTIALITY.before} for the term and five years after.

## 6. Refreshments

The Customer shall buy all office coffee beans from the roastery named in Schedule 4 for a decade.

## 7. Governing law

This agreement is governed by ${LAW.before}.
`;
const OTHER_SIDE_TEXT = "The Supplier may suspend the services at any time without notice.";

/** The MSA as the other side sent it back: their own tracked insertion already in it. */
function supplierMsa(): Uint8Array {
  const clean = buildDocx({
    blocks: markdownBlocks(MSA),
    author: "Pilot",
    date: "2026-11-16T00:00:00Z",
  });
  const services = readDocx(clean).paragraphs.find((p) => p.text.includes("hosted contract"));
  if (!services) throw new Error("the MSA lost its services clause");
  const patched = patchDocx(
    clean,
    [
      {
        id: "other-side",
        kind: "insert_after",
        paragraph_index: services.index,
        before: "",
        after: OTHER_SIDE_TEXT,
      },
    ],
    { author: GAP_SCRIPT.editAuthor, date: "2026-11-16T00:00:00Z" },
  );
  expect(patched.failed).toEqual([]);
  return patched.bytes;
}

// The summary's columns, as spec §4.8 lists them.
const RULE_COLUMNS = [
  "Rule",
  "Status",
  "Clause reference",
  "Evidence quote",
  "Recommended language",
  "Justification",
  "Decision",
  "Decided by",
  "Decided at",
];
const GAP_COLUMNS = [
  "Kind",
  "Severity",
  "Clause reference",
  "Evidence quote",
  "Reason",
  "Recommended language",
  "Decision",
  "Decided by",
  "Decided at",
];

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const { call, json, post, events, asOwner } = useStack();

const upload = async (vaultId: string, name: string, body: BlobPart, type: string) => {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  const { file } = await json<{ file: { id: string; version_id: string } }>(
    `/api/v1/vaults/${vaultId}/files`,
    { method: "POST", body: form },
    202,
  );
  return file;
};

const fromXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
const xmlText = (xml: string) =>
  fromXml([...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));
const part = (parts: Record<string, Uint8Array>, name: string) =>
  strFromU8(parts[name] ?? new Uint8Array());
/** An inline-string worksheet as rows of cell text. */
const sheetRows = (xml: string) =>
  [...xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((c) => fromXml(c[1] ?? "")),
  );

const startReview = async (playbookId: string, versionId: string, mode: string) => {
  const started = await post<{ review_id: string }>(
    `/api/v1/playbooks/${playbookId}/reviews`,
    { document_version_id: versionId, party: "Customer", paper: "theirs", mode, surface: "web" },
    201,
  );
  const { review } = await until(
    () => json<{ review: Review }>(`/api/v1/reviews/${started.review_id}`),
    (r) => ["done", "failed", "cancelled"].includes(r.review.status),
    "the review to finish",
  );
  expect(review.status).toBe("done");
  return review;
};

const byTitle = (review: Review, title: string): Finding => {
  const found = review.results.find((f) => f.rule_title === title);
  if (!found) throw new Error(`no finding for ${title}`);
  return found;
};

const shared: {
  vault: string;
  files: Map<string, (typeof CONTRACTS)[number]>;
  playbook: { id: string; rules: number };
  msa: { bytes: Uint8Array; versionId: string };
  review?: Review;
} = {
  vault: "",
  files: new Map(),
  playbook: { id: "", rules: 0 },
  msa: { bytes: new Uint8Array(), versionId: "" },
};

// The steps share state (vault, playbook, review), so they run in order and the first
// failure skips the rest rather than burying it under follow-on errors.
let broken = "";
beforeEach((ctx) => {
  if (broken) ctx.skip(`an earlier step failed: ${broken}`);
  ctx.onTestFailed(() => {
    broken = ctx.task.name;
  });
});

// Vitest 5 has no describe.sequential; concurrent: false pins the order even under --sequence.concurrent.
describe("pilot acceptance 2", { concurrent: false }, () => {
  it("uploads contracts into a vault", async () => {
    const { vault } = await post<{ vault: { id: string } }>(
      "/api/v1/vaults",
      { name: "Pilot 2 deal room" },
      201,
    );
    shared.vault = vault.id;
    for (const c of CONTRACTS) {
      const file = await upload(vault.id, c.name, c.text, "text/plain");
      shared.files.set(file.id, c);
    }
    const ids = [...shared.files.keys()];
    const tree = await until(
      () => json<{ files: { id: string; state: string }[] }>(`/api/v1/vaults/${vault.id}/tree`),
      (t) =>
        ids.every((id) =>
          ["ready", "failed"].includes(t.files.find((f) => f.id === id)?.state ?? ""),
        ),
      "the uploads to be read",
    );
    expect(ids.map((id) => tree.files.find((f) => f.id === id)?.state)).toEqual(["ready", "ready"]);
  });

  it.skipIf(!TABLES_LIVE)("review table: typed columns fill with verified citations", async () => {
    const { table } = await post<{ table: { id: string } }>(
      "/api/v1/review-tables",
      {
        name: "Pilot 2 table",
        source: { kind: "vault", vault_id: shared.vault, document_ids: [...shared.files.keys()] },
      },
      201,
    );
    const base = `/api/v1/review-tables/${table.id}`;
    const columns = [
      {
        label: "Governing law",
        type: "classify",
        prompt: "Which law governs this agreement?",
        options: {
          options: [
            { id: "england", label: "England and Wales", color: "blue" },
            { id: "new_york", label: "New York", color: "green" },
          ],
          allow_other: false,
        },
      },
      {
        label: "Termination notice",
        type: "number",
        prompt: "How many days of written notice does either party need to terminate?",
      },
    ];
    const ids: string[] = [];
    for (const column of columns) {
      const res = await call(`${base}/columns`, { method: "POST", body: JSON.stringify(column) });
      expect(res.ok, await res.clone().text()).toBe(true);
      ids.push(((await res.json()) as { column: { id: string } }).column.id);
    }
    for (const id of ids) {
      const res = await call(`${base}/columns/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ scope: "all" }),
      });
      expect(res.ok, await res.clone().text()).toBe(true);
      await res.body?.cancel();
    }
    await until(
      () => json<{ columns: { id: string; state: string }[] }>(base),
      (t) => ids.every((id) => t.columns.find((c) => c.id === id)?.state === "done"),
      "the table's columns to finish",
    );
    type Typed = { kind: string; option_ids?: string[]; value?: string };
    const page = await json<{
      rows: { id: string; document_ids: string[] }[];
      cells: {
        row_id: string;
        column_id: string;
        status: string;
        value_typed: Typed | null;
        citation_count: number;
        verified_citation_count: number;
      }[];
    }>(`${base}/rows?limit=200`);
    expect(page.rows).toHaveLength(CONTRACTS.length);
    for (const row of page.rows) {
      const expected = shared.files.get(row.document_ids[0] ?? "");
      expect(expected, `row ${row.id} is one of the uploads`).toBeDefined();
      const cell = (column: string) =>
        page.cells.find((c) => c.row_id === row.id && c.column_id === column);
      const law = cell(ids[0] ?? "");
      const notice = cell(ids[1] ?? "");
      expect(law?.value_typed).toEqual({ kind: "classify", option_ids: [expected?.law] });
      expect(notice?.value_typed).toMatchObject({ kind: "number", value: expected?.days });
      for (const c of [law, notice]) {
        expect(c?.status).toBe("done");
        expect(c?.citation_count).toBeGreaterThan(0);
        expect(c?.verified_citation_count).toBe(c?.citation_count);
      }
    }
  });

  it("playbook review: verified findings, suggestions and both kinds of gap", async () => {
    const created = await post<{ playbook: { id: string; rules: unknown[] } }>(
      "/api/v1/playbooks",
      {
        name: "Pilot MSA playbook",
        contract_type: "Master services agreement",
        source: { kind: "starter", template: "msa" },
      },
      201,
    );
    shared.playbook = { id: created.playbook.id, rules: created.playbook.rules.length };
    await post(`/api/v1/playbooks/${created.playbook.id}/publish`, {});

    const bytes = supplierMsa();
    const file = await upload(shared.vault, "Supplier MSA.docx", bytes, DOCX_MIME);
    shared.msa = { bytes, versionId: file.version_id };

    const review = await startReview(created.playbook.id, file.version_id, "standard");
    shared.review = review;

    // Every quote the review shows was found in the document.
    for (const f of review.results) {
      expect(f.verification, f.rule_title).toBe("ok");
      for (const e of f.evidence) expect(e.verified, f.rule_title).toBe("ok");
    }
    for (const g of review.gaps) for (const e of g.evidence) expect(e.verified).toBe("ok");

    const notAcceptable = review.results.filter((f) => f.status === "not_acceptable");
    expect(notAcceptable.map((f) => f.rule_title).sort()).toEqual([...NOT_ACCEPTABLE].sort());
    const paragraphs = readDocx(bytes).paragraphs;
    for (const f of notAcceptable) {
      const s = f.suggestion;
      expect(s, `${f.rule_title} has a suggestion`).toBeDefined();
      expect(s).toMatchObject({ kind: "replace", after: step(f.rule_title).after });
      const p = paragraphs[s?.anchor.paragraph_index ?? -1];
      expect(p?.text.slice(s?.anchor.char_from, s?.anchor.char_to)).toBe(s?.before);
    }
    expect(byTitle(review, CONFIDENTIALITY.title)).toMatchObject({
      status: "acceptable",
      matched: "standard",
    });
    expect(byTitle(review, CONFIDENTIALITY.title).explanation).not.toBe("");

    const uncovered = review.gaps.find((g) =>
      g.evidence.some((e) => GAP_SCRIPT.para.test(e.quote)),
    );
    expect(uncovered).toMatchObject({ kind: "uncovered_clause", severity: "high" });
    const edit = review.gaps.find((g) => g.kind === "existing_edit");
    expect(edit).toMatchObject({ severity: "high", reason: GAP_SCRIPT.editReason });
    expect(edit?.evidence[0]?.quote).toBe(OTHER_SIDE_TEXT);
    expect(review.warnings).toContain("existing_tracked_changes");
    expect(review.summary.gaps).toBe(review.gaps.length);
  });

  it("redline export: applied edits only, by Counsel, with their comments", async () => {
    const review = shared.review;
    if (!review) throw new Error("the playbook review didn't run");
    const suggestion = (title: string): Suggestion => {
      const s = byTitle(review, title).suggestion;
      if (!s) throw new Error(`${title} has no suggestion`);
      return s;
    };

    for (const { step: s, comment } of APPLY) {
      const applied = await post<{ status: string; comment_text?: string }>(
        `/api/v1/reviews/${review.id}/suggestions/${suggestion(s.title).id}/apply`,
        { with_comment: comment, surface: "web" },
      );
      expect(applied.status).toBe("applied");
      if (comment) expect(applied.comment_text?.startsWith(s.title)).toBe(true);
    }
    for (const s of DISMISS) {
      const dismissed = await post<{ suggestion: { status: string } }>(
        `/api/v1/reviews/${review.id}/suggestions/${suggestion(s.title).id}/dismiss`,
        {},
      );
      expect(dismissed.suggestion.status).toBe("dismissed");
    }

    const { review: after } = await json<{ review: Review }>(`/api/v1/reviews/${review.id}`);
    for (const { step: s, comment } of APPLY) {
      expect(byTitle(after, s.title).suggestion).toMatchObject({
        status: "applied",
        applied_with_comment: comment,
      });
    }
    for (const s of DISMISS) {
      expect(byTitle(after, s.title).suggestion?.status).toBe("dismissed");
    }

    // Each decision is in the audit trail, against the review and the suggestion.
    const trail = await asOwner<{
      action: string;
      details: { sid: string; with_comment?: boolean };
    }>(
      "select action, details from admin.audit_event where object_id = $1 and action like 'suggestion.%'",
      [review.id],
    );
    const audited = (action: string) =>
      trail
        .filter((r) => r.action === action)
        .map((r) => r.details.sid)
        .sort();
    expect(audited("suggestion.applied")).toEqual(
      APPLY.map((a) => suggestion(a.step.title).id).sort(),
    );
    expect(
      trail.find((r) => r.details.sid === suggestion(LIABILITY.title).id)?.details.with_comment,
    ).toBe(true);
    expect(audited("suggestion.dismissed")).toEqual(
      DISMISS.map((s) => suggestion(s.title).id).sort(),
    );

    const res = await call(`/api/v1/reviews/${review.id}/redline`, {
      method: "POST",
      body: JSON.stringify({ include_pending: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("wordprocessingml");
    expect(res.headers.get("x-redline-failed")).toBe("0");
    const bytes = new Uint8Array(await res.arrayBuffer());

    const read = readDocx(bytes);
    const ours = read.existingEdits.filter((e) => e.author === "Counsel");
    // The other side's insertion survives, still theirs.
    const theirs = read.existingEdits.filter((e) => e.author !== "Counsel");
    expect(theirs).toEqual([
      expect.objectContaining({
        author: GAP_SCRIPT.editAuthor,
        kind: "ins",
        text: OTHER_SIDE_TEXT,
      }),
    ]);
    // Exactly one deletion and one insertion at each applied anchor, and nothing else.
    for (const { step: s } of APPLY) {
      const at = suggestion(s.title).anchor.paragraph_index;
      const here = ours.filter((e) => e.paragraph_index === at);
      expect(here.map((e) => e.kind).sort(), s.title).toEqual(["del", "ins"]);
      expect(read.paragraphs[at]?.text).toContain(s.after);
    }
    expect(ours).toHaveLength(APPLY.length * 2);
    // The dismissed edits are absent: their clauses are untouched.
    for (const s of DISMISS) {
      expect(read.paragraphs.some((p) => p.text.includes(s.before))).toBe(true);
      expect(read.paragraphs.some((p) => p.text.includes(s.after))).toBe(false);
    }

    const parts = unzipSync(bytes);
    const comments = part(parts, "word/comments.xml");
    const each = [...comments.matchAll(/<w:comment [\s\S]*?<\/w:comment>/g)].map((m) => m[0]);
    const commented = APPLY.filter((a) => a.comment).map((a) => a.step.title);
    expect(each).toHaveLength(commented.length);
    for (const [i, title] of commented.entries()) {
      expect(xmlText(each[i] ?? "").startsWith(title)).toBe(true);
      expect(each[i]).toContain('w:author="Counsel"');
    }

    // Spec §4.6: the redline must open in LibreOffice. Opt in, since it's a large install.
    if (process.env.SOFFICE_TEST === "1") {
      expect(await sofficeValidator(process.env.SOFFICE_BIN || "soffice")(bytes)).toBe(true);
    }

    const xlsx = await call(`/api/v1/reviews/${review.id}/export`, {
      method: "POST",
      body: JSON.stringify({ format: "xlsx" }),
    });
    expect(xlsx.status).toBe(200);
    const book = unzipSync(new Uint8Array(await xlsx.arrayBuffer()));
    const names = [...part(book, "xl/workbook.xml").matchAll(/<sheet name="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(["Rules", "Gaps"]);
    const [ruleHead, ...rules] = sheetRows(part(book, "xl/worksheets/sheet1.xml"));
    expect(ruleHead).toEqual(RULE_COLUMNS);
    // One row per rule in scope; none of the starter rules is conditional, so none skipped.
    expect(after.results.filter((f) => f.status === "skipped")).toEqual([]);
    expect(rules).toHaveLength(shared.playbook.rules);
    const ruleRow = (title: string) => rules.find((r) => r[0] === title) ?? [];
    const decision = RULE_COLUMNS.indexOf("Decision");
    for (const { step: s } of APPLY) {
      expect(ruleRow(s.title)[decision]).toBe("applied");
      expect(ruleRow(s.title)[decision + 1]).not.toBe("");
    }
    for (const s of DISMISS) expect(ruleRow(s.title)[decision]).toBe("dismissed");
    expect(ruleRow(CONFIDENTIALITY.title)[decision]).toBe("");
    const [gapHead, ...gaps] = sheetRows(part(book, "xl/worksheets/sheet2.xml"));
    expect(gapHead).toEqual(GAP_COLUMNS);
    expect(gaps.map((g) => g[0]).sort()).toEqual(["Existing edit", "Uncovered clause"]);
    expect(gaps.find((g) => g[0] === "Uncovered clause")?.[3]).toContain("coffee beans");
  });

  it("redline-only review: no explanations, suggestions carry the reasoning", async () => {
    const review = await startReview(shared.playbook.id, shared.msa.versionId, "redline_only");
    expect(review.customisation.mode).toBe("redline_only");
    const acceptable = review.results.filter((f) => f.status === "acceptable");
    expect(acceptable.map((f) => f.rule_title)).toEqual([CONFIDENTIALITY.title]);
    for (const f of acceptable) expect(f.explanation).toBe("");
    const notAcceptable = review.results.filter((f) => f.status === "not_acceptable");
    expect(notAcceptable.map((f) => f.rule_title).sort()).toEqual([...NOT_ACCEPTABLE].sort());
    for (const f of notAcceptable) {
      expect(f.explanation).toBe("");
      expect(f.suggestion?.after).toBe(step(f.rule_title).after);
      expect(f.suggestion?.justification.trim()).not.toBe("");
    }
  });

  it("library: a draft exported through the firm's templates", async () => {
    const addTemplate = async (name: string, bytes: Uint8Array) => {
      const form = new FormData();
      form.set("name", name);
      form.set("file", new File([bytes], `${name}.docx`, { type: DOCX_MIME }));
      const { template } = await json<{
        template: { id: string; current: { placeholders: string[] } };
      }>("/api/v1/library/templates", { method: "POST", body: form }, 201);
      return template;
    };
    const letter = await addTemplate("Firm letter", sampleFirmTemplate());
    // LIB-004: a template with marks for the title and draft, and placeholders for the lawyer.
    const marked = await addTemplate("Firm letter with marks", sampleFirmTemplate({ marks: true }));
    expect(marked.current.placeholders).toEqual(["{{Counterparty}}", "[INSERT DATE]"]);

    const asked = await post<{ thread_id: string; run_id: string }>(
      "/api/v1/threads",
      {
        content: "What is the Supplier's liability cap?",
        scope: { document_ids: [], vault_ids: [shared.vault], sources: [] },
      },
      202,
    );
    expect((await events(asked.run_id)).at(-1)?.event).toBe("done");
    const { thread } = await json<{ thread: { messages: { id: string }[] } }>(
      `/api/v1/threads/${asked.thread_id}`,
    );
    const { draft } = await post<{
      draft: { id: string; title: string; latest: { body: string } };
    }>(
      `/api/v1/threads/${asked.thread_id}/drafts`,
      { kind: "editor", from_message_id: thread.messages.at(-1)?.id },
      201,
    );

    const exported = async (choice: string) => {
      const res = await call(`/api/v1/drafts/${draft.id}/export?format=docx&template=${choice}`);
      expect(res.status).toBe(200);
      return unzipSync(new Uint8Array(await res.arrayBuffer()));
    };
    const firm = unzipSync(sampleFirmTemplate());
    const out = await exported(letter.id);
    // The template's look wins, as in @legallabs/docx's own template tests.
    expect(part(out, "word/styles.xml")).toContain('<w:rFonts w:ascii="Georgia"');
    expect(part(out, "word/styles.xml")).toContain('w:styleId="FirmHeading1"');
    expect(part(out, "word/document.xml")).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(part(out, "word/header1.xml")).toBe(part(firm, "word/header1.xml"));
    expect(part(out, "word/footer1.xml")).toBe(part(firm, "word/footer1.xml"));
    expect(part(out, "word/document.xml")).not.toContain("Sample body text");

    // THR-008, with citations: the draft's markers [n] point into a numbered Sources list,
    // one entry each. Draft export writes no Word footnotes, so there are none to count.
    const markers = new Set(draft.latest.body.match(/\[\d+\]/g) ?? []);
    expect(markers.size).toBeGreaterThan(0);
    const text = xmlText(part(out, "word/document.xml"));
    expect(text).toContain("Sources");
    const sources = draft.latest.body.split("## Sources")[1] ?? "";
    expect(sources.match(/^\d+\. /gm)?.length).toBe(markers.size);
    for (const n of markers) expect(text).toContain(n);
    const footnotes = [...part(out, "word/footnotes.xml").matchAll(/<w:footnote w:id="(\d+)"/g)];
    expect(footnotes.filter((m) => Number(m[1]) > 0)).toHaveLength(0);

    // Marks: letterhead, then the title in the mark's style, the draft, the sign-off.
    const doc = part(await exported(marked.id), "word/document.xml");
    const letterhead = doc.indexOf("Level 9, 1 Example Street");
    const title = doc.indexOf(
      `<w:pStyle w:val="FirmTitle"/></w:pPr><w:r><w:t xml:space="preserve">${draft.title}`,
    );
    const sourcesAt = doc.indexOf(">Sources<");
    const signoff = doc.indexOf("Signed for {{Counterparty}}");
    expect(letterhead).toBeGreaterThan(-1);
    expect(letterhead).toBeLessThan(title);
    expect(title).toBeLessThan(sourcesAt);
    expect(sourcesAt).toBeLessThan(signoff);
    expect(doc).not.toContain("{{content}}");
    expect(doc).not.toContain("{{title}}");

    // Without a template the same draft keeps our defaults.
    const plain = await exported("none");
    expect(part(plain, "word/styles.xml")).not.toContain("Georgia");
    expect(plain["word/header1.xml"]).toBeUndefined();
  });
});
