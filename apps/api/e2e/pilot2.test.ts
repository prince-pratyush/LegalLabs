import type { Review } from "@legallabs/contracts";
import { buildDocx, markdownBlocks, readDocx } from "@legallabs/docx";
import { sampleFirmTemplate } from "@legallabs/docx/testing";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain script, shared with the stack.
import { GAP_SCRIPT, PLAYBOOK_SCRIPT } from "./model.mjs";
import { until, useStack } from "./session.js";

type Step = { title: string; before: string; after: string };
const [LIABILITY, PAYMENT] = PLAYBOOK_SCRIPT as Step[];
if (!LIABILITY || !PAYMENT) throw new Error("the model script lost a rule");

const contract = (days: number, law: string) => `MASTER SERVICES AGREEMENT

12. Liability
12.1 The Supplier's aggregate liability shall not exceed the fees paid in the twelve months before the claim.

13. Termination
13.1 Either party may terminate this agreement on ${days} days written notice.

14. Governing law
14.1 This agreement is governed by the laws of ${law}.
`;

// The MSA under review: one clause the playbook forbids, one it has no rule for.
const MSA = `# Master Services Agreement

## 1. Services

The Supplier shall provide the hosted contract management services described in each order form.

## 2. Fees

Fees are payable ${PAYMENT.before}.

## 3. Liability

${LIABILITY.before}.

## 4. Refreshments

The Customer shall buy all office coffee beans from the roastery named in Schedule 4 for a decade.
`;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const { call, json, post, events } = useStack();

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

const xmlText = (xml: string) =>
  [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

const shared: { vault: string; contracts: string[]; review?: Review } = {
  vault: "",
  contracts: [],
};

describe("pilot acceptance 2", () => {
  it("uploads contracts into a vault", async () => {
    const { vault } = await post<{ vault: { id: string } }>(
      "/api/v1/vaults",
      { name: "Pilot 2 deal room" },
      201,
    );
    shared.vault = vault.id;
    for (const [name, text] of [
      ["msa-england.txt", contract(90, "England and Wales")],
      ["msa-new-york.txt", contract(30, "New York")],
    ] as const) {
      const file = await upload(vault.id, name, text, "text/plain");
      shared.contracts.push(file.id);
    }
    const tree = await until(
      () => json<{ files: { id: string; state: string }[] }>(`/api/v1/vaults/${vault.id}/tree`),
      (t) =>
        shared.contracts.every((id) =>
          ["ready", "failed"].includes(t.files.find((f) => f.id === id)?.state ?? ""),
        ),
      "the uploads to be read",
    );
    expect(tree.files.filter((f) => shared.contracts.includes(f.id)).map((f) => f.state)).toEqual([
      "ready",
      "ready",
    ]);
  });

  // Runs once the review-table routes are on main. An empty create is a 400 there and a 404
  // until then; POST, because a list route may come later than create.
  it("review table: typed columns fill with verified citations", async (ctx) => {
    const probe = await call("/api/v1/review-tables", { method: "POST", body: "{}" });
    await probe.body?.cancel();
    if (probe.status === 404) {
      ctx.skip("review tables aren't merged yet: POST /api/v1/review-tables answers 404");
      return;
    }
    const { table } = await post<{ table: { id: string } }>(
      "/api/v1/review-tables",
      {
        name: "Pilot 2 table",
        source: { kind: "vault", vault_id: shared.vault, document_ids: shared.contracts },
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
    const page = await json<{
      rows: { id: string; document_ids: string[] }[];
      cells: {
        row_id: string;
        column_id: string;
        status: string;
        value_typed: { kind: string } | null;
        citation_count: number;
        verified_citation_count: number;
      }[];
    }>(`${base}/rows?limit=200`);
    expect(page.rows).toHaveLength(2);
    const cells = page.cells.filter((c) => ids.includes(c.column_id));
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.status).toBe("done");
      expect(cell.value_typed?.kind).toBe(cell.column_id === ids[0] ? "classify" : "number");
      expect(cell.citation_count).toBeGreaterThan(0);
      expect(cell.verified_citation_count).toBe(cell.citation_count);
    }
  });

  it("playbook review: verified findings, a suggestion and a gap", async () => {
    const created = await post<{ playbook: { id: string } }>(
      "/api/v1/playbooks",
      {
        name: "Pilot MSA playbook",
        contract_type: "Master services agreement",
        source: { kind: "starter", template: "msa" },
      },
      201,
    );
    const playbookId = created.playbook.id;
    await post(`/api/v1/playbooks/${playbookId}/publish`, {});

    const docx = buildDocx({
      blocks: markdownBlocks(MSA),
      author: "Pilot",
      date: "2026-11-16T00:00:00Z",
    });
    const file = await upload(shared.vault, "Supplier MSA.docx", docx, DOCX_MIME);

    const started = await post<{ review_id: string; run_id: string }>(
      `/api/v1/playbooks/${playbookId}/reviews`,
      { document_version_id: file.version_id, party: "Customer", paper: "theirs", surface: "web" },
      201,
    );
    const { review } = await until(
      () => json<{ review: Review }>(`/api/v1/reviews/${started.review_id}`),
      (r) => ["done", "failed", "cancelled"].includes(r.review.status),
      "the review to finish",
    );
    expect(review.status).toBe("done");
    shared.review = review;

    for (const f of review.results) {
      expect(f.verification, f.rule_title).toBe("ok");
      for (const e of f.evidence) expect(e.verified, f.rule_title).toBe("ok");
    }
    for (const g of review.gaps) for (const e of g.evidence) expect(e.verified).toBe("ok");

    const liability = review.results.find((f) => f.rule_title === LIABILITY.title);
    expect(liability?.status).toBe("not_acceptable");
    expect(liability?.evidence.length).toBeGreaterThan(0);
    expect(liability?.suggestion).toMatchObject({ kind: "replace", after: LIABILITY.after });
    const payment = review.results.find((f) => f.rule_title === PAYMENT.title);
    expect(payment?.suggestion).toMatchObject({ kind: "replace", after: PAYMENT.after });

    const gap = review.gaps.find((g) => g.evidence.some((e) => GAP_SCRIPT.para.test(e.quote)));
    expect(gap).toMatchObject({ kind: "uncovered_clause", severity: "high" });
    expect(review.summary.gaps).toBe(review.gaps.length);
  });

  it("redline export: only the applied edit, by Counsel, with its comment", async () => {
    const review = shared.review;
    if (!review) throw new Error("the playbook review didn't run");
    const sid = (title: string) =>
      review.results.find((f) => f.rule_title === title)?.suggestion?.id ?? "";

    const applied = await post<{ status: string; comment_text?: string }>(
      `/api/v1/reviews/${review.id}/suggestions/${sid(LIABILITY.title)}/apply`,
      { with_comment: true, surface: "web" },
    );
    expect(applied.status).toBe("applied");
    expect(applied.comment_text?.startsWith(LIABILITY.title)).toBe(true);
    const dismissed = await post<{ suggestion: { status: string } }>(
      `/api/v1/reviews/${review.id}/suggestions/${sid(PAYMENT.title)}/dismiss`,
      {},
    );
    expect(dismissed.suggestion.status).toBe("dismissed");

    const res = await call(`/api/v1/reviews/${review.id}/redline`, {
      method: "POST",
      body: JSON.stringify({ include_pending: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("wordprocessingml");
    expect(res.headers.get("x-redline-failed")).toBe("0");
    const bytes = new Uint8Array(await res.arrayBuffer());

    const read = readDocx(bytes);
    const liability = read.paragraphs.find((p) => p.text.includes(LIABILITY.after));
    expect(liability).toBeDefined();
    expect(read.existingEdits.length).toBeGreaterThan(0);
    for (const edit of read.existingEdits) {
      expect(edit.author).toBe("Counsel");
      expect(edit.paragraph_index).toBe(liability?.index);
    }
    // The dismissed edit is absent: its clause is untouched and its wording never appears.
    const payment = read.paragraphs.find((p) => p.text.includes(PAYMENT.before));
    expect(payment).toBeDefined();
    expect(read.paragraphs.some((p) => p.text.includes(PAYMENT.after))).toBe(false);

    const parts = unzipSync(bytes);
    const comments = strFromU8(parts["word/comments.xml"] ?? new Uint8Array());
    const each = [...comments.matchAll(/<w:comment [\s\S]*?<\/w:comment>/g)].map((m) =>
      xmlText(m[0]),
    );
    expect(each).toHaveLength(1);
    expect(each[0]?.startsWith(LIABILITY.title)).toBe(true);
    for (const comment of [...comments.matchAll(/<w:comment [^>]*>/g)]) {
      expect(comment[0]).toContain('w:author="Counsel"');
    }

    const xlsx = await call(`/api/v1/reviews/${review.id}/export`, {
      method: "POST",
      body: JSON.stringify({ format: "xlsx" }),
    });
    expect(xlsx.status).toBe(200);
    const book = unzipSync(new Uint8Array(await xlsx.arrayBuffer()));
    const workbook = strFromU8(book["xl/workbook.xml"] ?? new Uint8Array());
    const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Rules", "Gaps"]);
    const sheet = (n: number) => strFromU8(book[`xl/worksheets/sheet${n}.xml`] ?? new Uint8Array());
    const rules = sheet(1);
    expect(rules).toContain(LIABILITY.title);
    expect(rules).toContain(PAYMENT.title);
    expect(rules).toContain("applied");
    expect(rules).toContain("dismissed");
    expect(sheet(2)).toContain("coffee beans");
  });

  it("library: a draft exported through the firm's template", async () => {
    const form = new FormData();
    form.set("name", "Firm letter");
    form.set("file", new File([sampleFirmTemplate()], "Firm letter.docx", { type: DOCX_MIME }));
    const { template } = await json<{ template: { id: string } }>(
      "/api/v1/library/templates",
      { method: "POST", body: form },
      201,
    );

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
    const { draft } = await post<{ draft: { id: string } }>(
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
    const text = (parts: Record<string, Uint8Array>, name: string) =>
      strFromU8(parts[name] ?? new Uint8Array());
    const out = await exported(template.id);
    // The template's look wins, as in @legallabs/docx's own template tests.
    expect(text(out, "word/styles.xml")).toContain('<w:rFonts w:ascii="Georgia"');
    expect(text(out, "word/styles.xml")).toContain('w:styleId="FirmHeading1"');
    expect(text(out, "word/document.xml")).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(text(out, "word/header1.xml")).toBe(text(firm, "word/header1.xml"));
    expect(text(out, "word/footer1.xml")).toBe(text(firm, "word/footer1.xml"));
    expect(text(out, "word/document.xml")).not.toContain("Sample body text");
    expect(xmlText(text(out, "word/document.xml"))).toMatch(/\S/);
    // Without the template the same draft keeps our defaults.
    const plain = await exported("none");
    expect(text(plain, "word/styles.xml")).not.toContain("Georgia");
    expect(plain["word/header1.xml"]).toBeUndefined();
  });
});
