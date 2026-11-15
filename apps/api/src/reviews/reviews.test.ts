import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Finding, type Gap, paraHash, type Review, type Rule } from "@legallabs/contracts";
import { type Block, buildDocx, buildPdf, readDocx } from "@legallabs/docx";
import { createGateway, type ModelProvider } from "@legallabs/model-gateway";
import type { ReviewInput, ReviewOutcome, runReview } from "@legallabs/review";
import { strFromU8, unzipSync } from "fflate";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp } from "../db.js";
import { createDrafts } from "../drafts/drafts.js";
import { createPlaybooks, uuid7 } from "../playbooks/playbooks.js";
import { createRunLog } from "../runs/log.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { noKnowledge, noVaults } from "../threads/ports.js";
import { createThreads } from "../threads/threads.js";
import { createReviews } from "./reviews.js";

const pool = testPool();
afterAll(() => pool.end());

const CLAUSES = [
  "1. Liability. The supplier's liability under this agreement is unlimited.",
  "2. Term. This agreement lasts for two years.",
  "3. Payment. Invoices are payable within 90 days of receipt.",
];
const paragraph = (text: string): Block => ({ kind: "paragraph", runs: [{ text }] });
const contractDocx = (clauses = CLAUSES) =>
  buildDocx({ blocks: clauses.map(paragraph), author: "Test", date: "2026-01-01T00:00:00Z" });

// What the fake engine proposes, keyed by a word in the rule title.
const EDITS: Record<string, { find: string; before: string; after: string } | null> = {
  liability: { find: "Liability", before: "is unlimited", after: "is capped at the fees paid" },
  term: null,
  payment: { find: "Payment", before: "90 days", after: "30 days" },
};

type Engine = typeof runReview;
// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field.
type Json = any;

/** Stands in for the review engine: one finding per rule, no model calls. */
const fakeEngine =
  (
    opts: {
      hold?: boolean;
      holdScoped?: boolean;
      gap?: boolean;
      /** Calls the model once per rule, so spend can be capped. */
      callModel?: boolean;
      throws?: boolean;
      seen?: (input: ReviewInput) => void;
      beforeReturn?: () => Promise<void>;
    } = {},
  ): Engine =>
  async (input: ReviewInput, deps) => {
    opts.seen?.(input);
    if (opts.throws) throw new Error("engine broke");
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.001,
      models: ["fake/model"],
      calls: 1,
    };
    const scope = input.customisation.scope;
    const rules = input.rules.filter((r) => scope === "all" || scope.includes(r.id));
    deps.onEvent?.({
      type: "review.planned",
      clause_map_size: rules.length,
      rules_in_scope: rules.length,
      excluded_regions: {},
      warnings: [],
    });
    // holdScoped holds only re-runs (one rule in scope), so the review itself finishes.
    if (opts.hold || (opts.holdScoped && scope !== "all")) {
      await new Promise<void>((resolve) =>
        input.signal?.addEventListener("abort", () => resolve()),
      );
    }
    const results: Finding[] = [];
    for (const rule of rules) {
      if (opts.callModel) {
        if (input.signal?.aborted) break;
        await deps.complete({ task: "draft", system: "s", prompt: "p", json: true, maxTokens: 10 });
      }
      deps.onEvent?.({ type: "review.rule_started", rule_id: rule.id });
      const key = rule.title.toLowerCase().split(" ")[0] ?? "";
      const edit = EDITS[key];
      const word = rule.title.split(" ")[0] ?? rule.title;
      const p = input.paragraphs.find((x) => x.text.includes(edit?.find ?? word));
      const quote = p?.text.slice(3, 20) ?? "";
      const finding: Finding = {
        rule_id: rule.id,
        rule_title: rule.title,
        status: edit ? "not_acceptable" : "acceptable",
        flag: rule.flag,
        evidence: p
          ? [{ paragraph_index: p.index, char_from: 3, char_to: 20, quote, verified: "ok" }]
          : [],
        matched: edit ? "unacceptable" : "standard",
        explanation: edit ? "Off position." : "Matches.",
        verification: "ok",
        model: "fake/model",
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.001,
      };
      if (edit && p) {
        const from = p.text.indexOf(edit.before);
        finding.suggestion = {
          id: deps.newId?.() ?? uuid7(),
          rule_id: rule.id,
          anchor: {
            paragraph_index: p.index,
            char_from: from,
            char_to: from + edit.before.length,
            para_hash: p.para_hash,
          },
          kind: "replace",
          before: edit.before,
          after: edit.after,
          justification: `Brings ${rule.title} to the standard position.`,
          status: "pending",
        };
      }
      results.push(finding);
      deps.onEvent?.({
        type: "review.rule_finished",
        rule_id: rule.id,
        status: finding.status,
        has_suggestion: Boolean(finding.suggestion),
      });
    }
    const gaps: Gap[] = [];
    const term = input.paragraphs.find((p) => p.text.includes("Term"));
    if (opts.gap !== false && term && scope === "all") {
      gaps.push({
        id: deps.newId?.() ?? uuid7(),
        kind: "uncovered_clause",
        evidence: [
          { paragraph_index: term.index, char_from: 3, char_to: 7, quote: "Term", verified: "ok" },
        ],
        reason: "No rule covers renewal.",
        severity: "low",
      });
    }
    const count = (s: string) => results.filter((f) => f.status === s).length;
    const summary = {
      acceptable: count("acceptable"),
      needs_review: count("needs_review"),
      not_acceptable: count("not_acceptable"),
      not_found: count("not_found"),
      gaps: gaps.length,
    };
    const aborted = input.signal?.aborted === true;
    if (!aborted) {
      deps.onEvent?.({
        type: "review.done",
        summary,
        usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
      });
    }
    const outcome: ReviewOutcome = {
      clause_map: Object.fromEntries(rules.map((r) => [r.id, [0]])),
      uncovered: [],
      // A capped run keeps the rules it finished; a held one finished none.
      results: aborted && !opts.callModel ? [] : results,
      gaps: aborted ? [] : gaps,
      summary,
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001, models: ["fake/model"] },
      phases: {
        plan: { ...usage },
        rules: Object.fromEntries(rules.map((r) => [r.id, { ...usage }])),
        verify: { ...usage },
      },
      coverage: { paragraphs: input.paragraphs.length, read: input.paragraphs.length },
      warnings: [],
      aborted,
    };
    await opts.beforeReturn?.();
    return outcome;
  };

function harness(
  engine: Engine = fakeEngine(),
  reply: () => string = () => "{}",
  limits: { maxActive?: number; maxCostUsd?: number; asksPerWindow?: number } = {},
) {
  const provider: ModelProvider = {
    complete: async () => ({ text: reply(), usage: { input_tokens: 10, output_tokens: 10 } }),
  };
  const gateway = createGateway({
    providers: { anthropic: provider },
    recordUsage: async () => {},
  });
  const documents = testDocuments(pool);
  const log = createRunLog(pool);
  // One log for threads and reviews, as the server has, so /runs/:id/cancel reaches reviews.
  const threads = {
    ...testThreads(pool, documents),
    log,
    threads: createThreads(pool, {
      gateway,
      documents,
      log,
      vaults: noVaults,
      knowledge: noKnowledge,
    }),
    ...(limits.asksPerWindow ? { asksPerWindow: limits.asksPerWindow } : {}),
  };
  const reviews = createReviews(pool, {
    gateway,
    store: documents.store,
    log,
    run: engine,
    now: () => new Date("2026-11-15T10:00:00Z"),
    ...(limits.maxActive ? { maxActive: limits.maxActive } : {}),
    ...(limits.maxCostUsd ? { maxCostUsd: limits.maxCostUsd } : {}),
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads,
    drafts: createDrafts(pool, { gateway }),
    playbooks: createPlaybooks(pool, { gateway }),
    reviews,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const raw = (cookie: string, method: string, path: string, json?: unknown) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  const call = async (
    cookie: string,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const res = await raw(cookie, method, path, json);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { app, documents, log, signIn, call, raw };
}
type Harness = ReturnType<typeof harness>;

async function colleague(m: Seeded, name: string, permissions: string[]) {
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const roleId = await one(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, name, permissions],
  );
  const email = `${name}@${m.slug}.test`;
  const userId = await one(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, roleId],
  );
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { ...m, userId, email };
}

const RULES = [
  { title: "Liability cap", standard_position: "Capped at fees paid." },
  { title: "Term length", standard_position: "Two years or less." },
  { title: "Payment terms", standard_position: "Thirty days." },
];

async function setup(
  h: Harness,
  opts: { publish?: boolean; bytes?: Uint8Array; name?: string } = {},
) {
  const m = await seedMember(pool);
  const cookie = await h.signIn(m);
  const created = await h.call(cookie, "POST", "/playbooks", {
    name: "MSA positions",
    contract_type: "MSA",
    source: { kind: "scratch", rules: RULES },
  });
  expect(created.status).toBe(201);
  const playbook = created.body.playbook as { id: string; rules: Rule[] };
  if (opts.publish !== false) {
    expect((await h.call(cookie, "POST", `/playbooks/${playbook.id}/publish`)).status).toBe(200);
  }
  const principal = { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
  const uploaded = await h.documents.upload(
    principal,
    { name: opts.name ?? "msa.docx", bytes: opts.bytes ?? contractDocx(), matterId: null },
    { ip: null, userAgent: null },
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  return { m, cookie, playbook, versionId: uploaded.document.versionId };
}

async function waitFor(
  h: Harness,
  cookie: string,
  id: string,
  done = ["done", "failed", "cancelled"],
) {
  for (let i = 0; i < 100; i++) {
    const { body } = await h.call(cookie, "GET", `/reviews/${id}`);
    if (done.includes(body.review.status)) return body.review as Review;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("review never finished");
}

async function started(h: Harness, s: Awaited<ReturnType<typeof setup>>, extra: object = {}) {
  const res = await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/reviews`, {
    document_version_id: s.versionId,
    party: "Acme (Customer)",
    surface: "web",
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { review_id: string; run_id: string };
}

const sidOf = (review: Review, title: string) => {
  const s = review.results.find((f) => f.rule_title.startsWith(title))?.suggestion;
  if (!s) throw new Error(`no suggestion for ${title}`);
  return s.id;
};

/** Polls a run until it reaches one of the statuses. */
async function runStatus(runId: string, want: string[]) {
  for (let i = 0; i < 150; i++) {
    const { rows } = await pool.query("select status from work.run where id = $1", [runId]);
    if (want.includes(rows[0]?.status)) return rows[0]?.status as string;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} never reached ${want.join("/")}`);
}
const runDone = (runId: string) => runStatus(runId, ["done"]);

async function upload(h: Harness, s: { m: Seeded }, name: string, clauses: string[]) {
  const principal = { sessionId: "s", userId: s.m.userId, workspaceId: s.m.workspaceId };
  const uploaded = await h.documents.upload(
    principal,
    { name, bytes: contractDocx(clauses), matterId: null },
    { ip: null, userAgent: null },
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  return uploaded.document.versionId;
}

/** Moves the document into a vault the given colleague can view. */
async function shareInVault(s: { m: Seeded }, documentId: string, userId: string) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Deals') returning id",
    [s.m.workspaceId, s.m.userId],
  );
  const vaultId = rows[0]?.id;
  await pool.query("update content.document set vault_id = $2 where id = $1", [
    documentId,
    vaultId,
  ]);
  await pool.query(
    `insert into core.share_grant
       (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
     values ($1, 'vault', $2, 'user', $3, 'view', $4)`,
    [s.m.workspaceId, vaultId, userId, s.m.userId],
  );
  return vaultId as string;
}

/** Queries as the given person under RLS, as the API would. */
const asUser = <T>(
  who: Pick<Seeded, "userId" | "workspaceId">,
  work: (db: pg.PoolClient) => Promise<T>,
) => asApp(pool, { userId: who.userId, workspaceId: who.workspaceId }, work);

describe("playbook reviews", () => {
  it("runs a review, records its steps and events, and audits it", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id, run_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    expect(review.status).toBe("done");
    expect(review.playbook_name).toBe("MSA positions");
    expect(review.document_name).toBe("msa.docx");
    expect(review.summary).toMatchObject({ acceptable: 1, not_acceptable: 2, gaps: 1 });
    expect(review.results.filter((f) => f.suggestion?.status === "pending")).toHaveLength(2);

    const steps = await pool.query<{ kind: string; input_ref: string | null; model: string }>(
      "select kind, input_ref, model from work.run_step where run_id = $1 order by ordinal",
      [run_id],
    );
    expect(steps.rows.map((r) => r.kind)).toEqual([
      "plan",
      "generate",
      "generate",
      "generate",
      "verify",
    ]);
    expect(steps.rows.filter((r) => r.input_ref?.startsWith("rule:"))).toHaveLength(3);
    expect(steps.rows.every((r) => r.model === "fake/model")).toBe(true);

    // The results are saved before the closing event, so readers never see "done" early.
    let events: Awaited<ReturnType<typeof h.log.replay>> = [];
    for (let i = 0; i < 100; i++) {
      events = await h.log.replay(
        { sessionId: "s", userId: s.m.userId, workspaceId: s.m.workspaceId },
        run_id,
        0,
      );
      if (events.at(-1)?.type === "status" && events.length > 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const types = events.map((e) => e.type as string);
    expect(types[0]).toBe("status");
    expect(types).toContain("review.planned");
    expect(types.filter((t) => t === "review.rule_finished")).toHaveLength(3);
    expect(types.at(-1)).toBe("status");
    const run = await pool.query("select status, kind from work.run where id = $1", [run_id]);
    expect(run.rows[0]).toEqual({ status: "done", kind: "playbook_review" });

    const trail = await auditTrail(pool, s.m.workspaceId);
    const actions = trail.map((r) => r.action);
    expect(actions).toContain("playbook_review.started");
    expect(actions).toContain("playbook_review.finished");
    // Clause text never reaches the audit trail.
    expect(JSON.stringify(trail)).not.toContain("unlimited");

    const listed = await h.call(
      s.cookie,
      "GET",
      `/reviews?filter[document_id]=${review.document_id}`,
    );
    expect(listed.body.reviews.map((r: { id: string }) => r.id)).toEqual([review_id]);
    expect(listed.body.reviews[0].results).toBeUndefined();

    const doc = await h.call(s.cookie, "GET", `/reviews/${review_id}/document`);
    expect(doc.body.kind).toBe("docx");
    expect(doc.body.paragraphs.map((p: { text: string }) => p.text)).toEqual(CLAUSES);
  });

  it("reviews only a published version, unless an editor asks for the draft", async () => {
    const h = harness();
    const s = await setup(h, { publish: false });
    const body = { document_version_id: s.versionId, party: "Acme", surface: "web" };
    const refused = await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/reviews`, body);
    expect(refused).toMatchObject({ status: 422, body: { code: "NOT_PUBLISHED" } });
    const draft = await h.call(
      s.cookie,
      "POST",
      `/playbooks/${s.playbook.id}/reviews?version=draft`,
      body,
    );
    expect(draft.status).toBe(201);
    const reader = await colleague(s.m, "reader", ["playbooks.use", "threads.use"]);
    const rc = await h.signIn(reader);
    const hidden = await h.call(
      rc,
      "POST",
      `/playbooks/${s.playbook.id}/reviews?version=draft`,
      body,
    );
    expect(hidden.status).toBe(404);
  });

  it("hides a review from someone who can't read the document", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    // A playbook reader who doesn't own the (non-vault) document.
    const reader = await colleague(s.m, "reader", ["playbooks.use", "threads.use"]);
    const rc = await h.signIn(reader);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(404);
    expect((await h.call(rc, "GET", "/reviews")).body.reviews).toEqual([]);
    const sid = sidOf(review, "Liability");
    const apply = await h.call(rc, "POST", `/reviews/${review_id}/suggestions/${sid}/apply`, {
      surface: "web",
    });
    expect(apply.status).toBe(404);
    // Nor can they start one on that document.
    const start = await h.call(rc, "POST", `/playbooks/${s.playbook.id}/reviews`, {
      document_version_id: s.versionId,
      party: "Acme",
      surface: "web",
    });
    expect(start.status).toBe(404);
  });

  it("applies, dismisses and applies all, with the fragment for the web", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const liability = sidOf(review, "Liability");
    const applied = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${liability}/apply`,
      {
        surface: "web",
        with_comment: true,
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      suggestion_id: liability,
      status: "applied",
      replace_mode: "paragraph",
      comment_text: "Liability cap: Brings Liability cap to the standard position.",
    });
    expect(applied.body.ooxml).toContain('w:author="Counsel"');
    expect(applied.body.ooxml).toContain("<w:ins ");
    expect(applied.body.ooxml).toContain("fees paid");

    const payment = sidOf(review, "Payment");
    const dismissed = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${payment}/dismiss`,
      {},
    );
    expect(dismissed.body.suggestion.status).toBe("dismissed");
    const again = await h.call(s.cookie, "POST", `/reviews/${review_id}/suggestions/apply-all`, {
      surface: "web",
    });
    expect(again.body).toEqual({ applied: [], failed: [] });

    const after = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review as Review;
    const lia = after.results.find((f) => f.rule_title === "Liability cap")?.suggestion;
    expect(lia).toMatchObject({
      status: "applied",
      applied_with_comment: true,
      decided_by: s.m.userId,
    });
    const actions = (await auditTrail(pool, s.m.workspaceId)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["suggestion.applied", "suggestion.dismissed"]));
  });

  it("applies every pending suggestion in document order", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const all = await h.call(s.cookie, "POST", `/reviews/${review_id}/suggestions/apply-all`, {
      surface: "web",
      with_comment: false,
    });
    expect(all.body.applied).toEqual([sidOf(review, "Liability"), sidOf(review, "Payment")]);
    expect(all.body.failed).toEqual([]);
  });

  it("records anchor_failed when Word saw a changed paragraph", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const sid = sidOf(review, "Liability");
    const drifted = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sid}/apply`,
      {
        surface: "word",
        with_comment: false,
        observed: { paragraph_index: 0, para_hash: await paraHash("Something else entirely") },
      },
    );
    expect(drifted.body).toMatchObject({ status: "anchor_failed" });
    expect(drifted.body.ooxml).toBeUndefined();
    const sid2 = sidOf(review, "Payment");
    const anchor = review.results.find((f) => f.rule_title === "Payment terms")?.suggestion?.anchor;
    const same = await h.call(s.cookie, "POST", `/reviews/${review_id}/suggestions/${sid2}/apply`, {
      surface: "word",
      observed: { paragraph_index: anchor?.paragraph_index, para_hash: anchor?.para_hash },
    });
    expect(same.body.status).toBe("applied");
    const after = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review as Review;
    expect(after.results.find((f) => f.rule_title === "Liability cap")?.suggestion?.status).toBe(
      "anchor_failed",
    );
  });

  it("offers alternates once and revises into a new suggestion", async () => {
    let reply = JSON.stringify({
      alternates: [
        { after: "is capped at twice the fees paid", justification: "A softer cap." },
        { after: "is capped at the fees paid", justification: "Same as the suggestion." },
      ],
    });
    const h = harness(fakeEngine(), () => reply);
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const sid = sidOf(review, "Liability");
    const alts = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sid}/alternates`,
    );
    expect(alts.status).toBe(200);
    expect(alts.body.alternates.map((a: { after: string }) => a.after)).toEqual([
      "is capped at twice the fees paid",
    ]);
    reply = "{}";
    const cached = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sid}/alternates`,
    );
    expect(cached.body.alternates).toEqual(alts.body.alternates);

    // Applying an alternate puts its text in the fragment.
    const alt = alts.body.alternates[0];
    const applied = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sid}/apply`,
      {
        surface: "web",
        alternate_id: alt.id,
      },
    );
    expect(applied.body.ooxml).toContain("twice the fees paid");

    reply = JSON.stringify({ after: "within 45 days", justification: "Meets halfway." });
    const payment = sidOf(review, "Payment");
    const revised = await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${payment}/revise`,
      {
        instruction: "Offer 45 days instead",
      },
    );
    expect(revised.status).toBe(200);
    expect(revised.body.suggestion).toMatchObject({
      after: "within 45 days",
      status: "pending",
      before: "90 days",
    });
    expect(revised.body.suggestion.id).not.toBe(payment);
    const after = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review as Review;
    expect(after.results.find((f) => f.rule_title === "Payment terms")?.suggestion?.id).toBe(
      revised.body.suggestion.id,
    );
    const old = await pool.query(
      "select status, superseded_by from work.review_suggestion where id = $1",
      [payment],
    );
    expect(old.rows[0]).toEqual({
      status: "superseded",
      superseded_by: revised.body.suggestion.id,
    });
    const actions = (await auditTrail(pool, s.m.workspaceId)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["suggestion.alternates_requested", "suggestion.revised"]),
    );
  });

  it("cancels a running review", async () => {
    const h = harness(fakeEngine({ hold: true }));
    const s = await setup(h);
    const { review_id, run_id } = await started(h, s);
    await waitFor(h, s.cookie, review_id, ["running", "planned"]);
    const res = await h.raw(s.cookie, "POST", `/reviews/${review_id}/cancel`);
    expect(res.status).toBe(202);
    const review = await waitFor(h, s.cookie, review_id);
    expect(review.status).toBe("cancelled");
    const run = await pool.query("select status from work.run where id = $1", [run_id]);
    expect(run.rows[0]?.status).toBe("cancelled");
    expect((await h.raw(s.cookie, "POST", `/reviews/${review_id}/cancel`)).status).toBe(404);
    const actions = (await auditTrail(pool, s.m.workspaceId)).map((r) => r.action);
    expect(actions).toContain("playbook_review.cancelled");
  });

  it("re-runs one rule against the review's own version and replaces its suggestion", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const old = sidOf(review, "Payment");
    const rule = s.playbook.rules.find((r) => r.title === "Payment terms");
    const rerun = await h.call(s.cookie, "POST", `/reviews/${review_id}/rules/${rule?.id}/rerun`, {
      document_version_id: s.versionId,
    });
    expect(rerun.status).toBe(202);
    await runDone(rerun.body.run_id);
    const after = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review as Review;
    const now = after.results.find((f) => f.rule_title === "Payment terms");
    expect(now?.suggestion?.id).not.toBe(old);
    expect(now?.source_document_version_id).toBeUndefined();
    const prev = await pool.query("select status from work.review_suggestion where id = $1", [old]);
    expect(prev.rows[0]?.status).toBe("superseded");
    const steps = await pool.query("select kind from work.run_step where run_id = $1", [
      rerun.body.run_id,
    ]);
    expect(steps.rows.map((r) => r.kind)).toContain("generate");
    const unknown = await h.call(s.cookie, "POST", `/reviews/${review_id}/rules/${uuid7()}/rerun`, {
      document_version_id: s.versionId,
    });
    expect(unknown.body.code).toBe("RULE_NOT_FOUND");
  });

  it("keeps a re-run of another document to the owner, and out of redlines and summaries", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const old = sidOf(review, "Payment");
    // A colleague who can read the reviewed document (through a vault) but not the new one.
    const reader = await colleague(s.m, "reader", ["playbooks.use", "threads.use"]);
    await shareInVault(s, review.document_id, reader.userId);
    const rc = await h.signIn(reader);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(200);

    // Word uploads the edited contract as a new document and re-runs against it.
    const fresh = await upload(h, s, "msa from word.docx", [
      ...CLAUSES.slice(0, 2),
      "3. Payment. Invoices are payable within 90 days of receipt. SECRET-B",
    ]);
    const rule = s.playbook.rules.find((r) => r.title === "Payment terms");
    // Someone who can't read B can't re-run against it, even on a review they can see.
    const blocked = await h.call(rc, "POST", `/reviews/${review_id}/rules/${rule?.id}/rerun`, {
      document_version_id: fresh,
    });
    expect([403, 404]).toContain(blocked.status);
    const rerun = await h.call(s.cookie, "POST", `/reviews/${review_id}/rules/${rule?.id}/rerun`, {
      document_version_id: fresh,
    });
    expect(rerun.status).toBe(202);
    await runDone(rerun.body.run_id);

    const mine = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review as Review;
    const ownFinding = mine.results.find((f) => f.rule_title === "Payment terms");
    expect(ownFinding?.source_document_version_id).toBe(fresh);
    expect(ownFinding?.evidence[0]?.quote).toBeDefined();
    expect(ownFinding?.suggestion?.source_document_version_id).toBe(fresh);
    expect(ownFinding?.suggestion?.id).not.toBe(old);

    // The colleague still sees the review's own finding, and nothing of B.
    const theirs = await h.call(rc, "GET", `/reviews/${review_id}`);
    expect(JSON.stringify(theirs.body)).not.toContain(fresh);
    expect(JSON.stringify(theirs.body)).not.toContain("SECRET-B");
    const theirFinding = (theirs.body.review as Review).results.find(
      (f) => f.rule_title === "Payment terms",
    );
    expect(theirFinding?.suggestion?.id).toBe(old);
    const raw = await asUser(reader, (db) =>
      db.query(
        "select 1 from work.review_rerun union all select 1 from work.review_suggestion where source_document_version_id is not null",
      ),
    );
    expect(raw.rows).toEqual([]);

    // The redline and summary are of the reviewed document: B's suggestion stays out.
    await h.call(s.cookie, "POST", `/reviews/${review_id}/suggestions/apply-all`, {
      surface: "web",
    });
    const redline = await h.raw(s.cookie, "POST", `/reviews/${review_id}/redline`, {
      include_pending: true,
    });
    const read = readDocx(new Uint8Array(await redline.arrayBuffer()));
    expect(read.paragraphs[2]?.text).toContain("30 days");
    expect(read.paragraphs.map((p) => p.text).join(" ")).not.toContain("SECRET-B");
    const exported = await h.raw(s.cookie, "POST", `/reviews/${review_id}/export`, {
      format: "xlsx",
    });
    const sheet = strFromU8(
      unzipSync(new Uint8Array(await exported.arrayBuffer()))["xl/worksheets/sheet1.xml"] ??
        new Uint8Array(),
    );
    expect(sheet).not.toContain("SECRET-B");
  });

  it("ends a re-run that the review's cancel stops", async () => {
    const h = harness(fakeEngine({ holdScoped: true }));
    const s = await setup(h);
    const { review_id } = await started(h, s);
    await waitFor(h, s.cookie, review_id);
    const rule = s.playbook.rules[0];
    const rerun = await h.call(s.cookie, "POST", `/reviews/${review_id}/rules/${rule?.id}/rerun`, {
      document_version_id: s.versionId,
    });
    await runStatus(rerun.body.run_id, ["running"]);
    expect((await h.raw(s.cookie, "POST", `/reviews/${review_id}/cancel`)).status).toBe(202);
    expect(await runStatus(rerun.body.run_id, ["cancelled"])).toBe("cancelled");
    // The finished review itself is untouched.
    expect((await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review.status).toBe(
      "done",
    );
  });

  it("stops a re-run cancelled through the runs endpoint", async () => {
    const h = harness(fakeEngine({ holdScoped: true }));
    const s = await setup(h);
    const { review_id } = await started(h, s);
    await waitFor(h, s.cookie, review_id);
    const rule = s.playbook.rules[0];
    const rerun = await h.call(s.cookie, "POST", `/reviews/${review_id}/rules/${rule?.id}/rerun`, {
      document_version_id: s.versionId,
    });
    await runStatus(rerun.body.run_id, ["running"]);
    expect((await h.raw(s.cookie, "POST", `/runs/${rerun.body.run_id}/cancel`)).status).toBe(202);
    expect(await runStatus(rerun.body.run_id, ["cancelled"])).toBe("cancelled");
  });

  it("refuses a document over a million characters", async () => {
    const h = harness();
    const big = contractDocx(["x".repeat(1_000_001)]);
    const s = await setup(h, { bytes: big, name: "huge.docx" });
    const res = await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/reviews`, {
      document_version_id: s.versionId,
      party: "Acme",
      surface: "web",
    });
    expect(res).toMatchObject({ status: 422, body: { code: "DOC_TOO_LARGE" } });
  });

  it("reviews a PDF for findings only: no redline", async () => {
    const h = harness();
    const pdf = await buildPdf({
      blocks: CLAUSES.map(paragraph),
      author: "Test",
      date: "2026-01-01T00:00:00Z",
    });
    const s = await setup(h, { bytes: pdf, name: "msa.pdf" });
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    expect(review.status).toBe("done");
    expect(review.warnings).toContain("pdf_no_redlines");
    const redline = await h.call(s.cookie, "POST", `/reviews/${review_id}/redline`, {
      include_pending: true,
    });
    expect(redline).toMatchObject({ status: 422, body: { code: "REDLINE_NEEDS_DOCX" } });
    const doc = await h.call(s.cookie, "GET", `/reviews/${review_id}/document`);
    expect(doc.body.kind).toBe("pdf");
  });
});

describe("review lifecycle and limits", () => {
  it("marks the review running with its run", async () => {
    const h = harness(fakeEngine({ hold: true }));
    const s = await setup(h);
    const { review_id, run_id } = await started(h, s);
    await runStatus(run_id, ["running"]);
    const review = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review;
    expect(review.status).toBe("running");
    expect(review.rules.map((r: { title: string }) => r.title)).toEqual(RULES.map((r) => r.title));
    await h.raw(s.cookie, "POST", `/reviews/${review_id}/cancel`);
  });

  it("fails both the run and the review when the engine throws", async () => {
    const h = harness(fakeEngine({ throws: true }));
    const s = await setup(h);
    const { review_id, run_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    expect(review.status).toBe("failed");
    // The stored row catches up just after the run, which readers already see as failed.
    let stored = "";
    for (let i = 0; i < 100 && stored !== "failed"; i++) {
      const row = await pool.query("select status from work.playbook_review where id = $1", [
        review_id,
      ]);
      stored = row.rows[0]?.status;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(stored).toBe("failed");
    expect(await runStatus(run_id, ["failed"])).toBe("failed");
  });

  it("never overwrites a review cancelled while its results were being saved", async () => {
    let reviewId = "";
    const h = harness(
      fakeEngine({
        // The engine has finished; the user cancels before the results are written.
        beforeReturn: async () => {
          await pool.query("update work.playbook_review set status = 'cancelled' where id = $1", [
            reviewId,
          ]);
        },
      }),
    );
    const s = await setup(h);
    const { review_id, run_id } = await started(h, s);
    reviewId = review_id;
    expect(await runStatus(run_id, ["cancelled", "done"])).toBe("cancelled");
    const review = (await h.call(s.cookie, "GET", `/reviews/${review_id}`)).body.review as Review;
    expect(review.status).toBe("cancelled");
    const kept = await pool.query("select 1 from work.review_suggestion where review_id = $1", [
      review_id,
    ]);
    expect(kept.rows).toEqual([]);
  });

  it("caps the reviews one person runs at once", async () => {
    const h = harness(fakeEngine({ hold: true }), undefined, { maxActive: 1 });
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const second = await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/reviews`, {
      document_version_id: s.versionId,
      party: "Acme",
      surface: "web",
    });
    expect(second).toMatchObject({ status: 429, body: { code: "TOO_MANY_REVIEWS" } });
    await h.raw(s.cookie, "POST", `/reviews/${review_id}/cancel`);
  });

  it("charges the ask budget by the rules in scope", async () => {
    const h = harness(fakeEngine(), undefined, { asksPerWindow: 2 });
    const s = await setup(h);
    // 25 rules cost three asks, more than the two allowed.
    const many = await h.call(s.cookie, "POST", "/playbooks", {
      name: "Long",
      contract_type: "MSA",
      source: {
        kind: "scratch",
        rules: Array.from({ length: 25 }, (_, i) => ({
          title: `Rule ${i}`,
          standard_position: "x",
        })),
      },
    });
    await h.call(s.cookie, "POST", `/playbooks/${many.body.playbook.id}/publish`);
    const res = await h.raw(s.cookie, "POST", `/playbooks/${many.body.playbook.id}/reviews`, {
      document_version_id: s.versionId,
      party: "Acme",
      surface: "web",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("stops at the cost cap, keeps finished rules and says why", async () => {
    const h = harness(fakeEngine({ callModel: true }), () => "{}", { maxCostUsd: 1e-9 });
    const s = await setup(h);
    const { review_id, run_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    expect(review.status).toBe("failed");
    expect(review.results.map((f) => f.rule_title)).toEqual(["Liability cap"]);
    let last: unknown;
    for (let i = 0; i < 100; i++) {
      const events = await h.log.replay(
        { sessionId: "s", userId: s.m.userId, workspaceId: s.m.workspaceId },
        run_id,
        0,
      );
      last = events.at(-1);
      if ((last as { type?: string })?.type === "error") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(last).toMatchObject({ type: "error", code: "COST_CAP" });
    expect(await runStatus(run_id, ["failed"])).toBe("failed");
  });

  it("reads attached files into the background, under the caller's access", async () => {
    let extra: string | undefined;
    const h = harness(
      fakeEngine({
        seen: (input) => {
          extra = input.extraContext;
        },
      }),
    );
    const s = await setup(h);
    const principal = { sessionId: "s", userId: s.m.userId, workspaceId: s.m.workspaceId };
    const attached = await h.documents.upload(
      principal,
      {
        name: "side letter.docx",
        bytes: contractDocx(["Side letter: fees fixed."]),
        matterId: null,
      },
      { ip: null, userAgent: null },
    );
    if (!attached.ok) throw new Error(attached.reason);
    const { review_id } = await started(h, s, {
      extra_context: { text: "Renewal deal.", document_ids: [attached.document.id] },
    });
    await waitFor(h, s.cookie, review_id);
    expect(extra).toContain("Renewal deal.");
    expect(extra).toContain("Side letter: fees fixed.");

    // Someone else's file can't be pulled in.
    const other = await seedMember(pool);
    const res = await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/reviews`, {
      document_version_id: s.versionId,
      party: "Acme",
      surface: "web",
      extra_context: { document_ids: [other.userId] },
    });
    expect(res.status).toBe(404);
  });

  it("starts from a thread only when the caller owns it", async () => {
    const h = harness();
    const s = await setup(h);
    const other = await colleague(s.m, "other", ["threads.use", "playbooks.use"]);
    const { rows } = await pool.query<{ id: string }>(
      "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Theirs') returning id",
      [s.m.workspaceId, other.userId],
    );
    const res = await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/reviews`, {
      document_version_id: s.versionId,
      party: "Acme",
      surface: "web",
      thread_id: rows[0]?.id,
    });
    expect(res.status).toBe(404);
  });
});

describe("review access over time", () => {
  it("hides a review once a wall shuts the reader out of its document", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const reader = await colleague(s.m, "reader", ["playbooks.use", "threads.use"]);
    await shareInVault(s, review.document_id, reader.userId);
    const rc = await h.signIn(reader);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(200);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name)
       values ($1, 'C1', 'Client', 'M1', 'M1') returning id`,
      [s.m.workspaceId],
    );
    await pool.query("update content.document set matter_id = $2 where id = $1", [
      review.document_id,
      rows[0]?.id,
    ]);
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [s.m.workspaceId, rows[0]?.id, reader.userId],
    );
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(404);
    // The owner is not walled and still sees it.
    expect((await h.call(s.cookie, "GET", `/reviews/${review_id}`)).status).toBe(200);
  });

  it("hides a review from a reader who loses the document, and from other workspaces", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const reader = await colleague(s.m, "reader", ["playbooks.use", "threads.use"]);
    await shareInVault(s, review.document_id, reader.userId);
    const rc = await h.signIn(reader);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(200);
    await pool.query("delete from core.share_grant where principal_id = $1", [reader.userId]);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(404);

    const stranger = await seedMember(pool);
    const sc = await h.signIn(stranger);
    expect((await h.call(sc, "GET", `/reviews/${review_id}`)).status).toBe(404);
    expect((await h.call(sc, "GET", "/reviews")).body.reviews).toEqual([]);
    const redline = await h.call(sc, "POST", `/reviews/${review_id}/redline`, {
      include_pending: true,
    });
    expect(redline.status).toBe(404);
  });

  it("keeps a review for its owner after the playbook is unpublished or deleted", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    const reader = await colleague(s.m, "reader", ["playbooks.use", "threads.use"]);
    await shareInVault(s, review.document_id, reader.userId);
    const rc = await h.signIn(reader);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(200);

    // Unpublished, the playbook is hidden from a plain reader, and so is the review.
    await h.call(s.cookie, "POST", `/playbooks/${s.playbook.id}/unpublish`);
    expect((await h.call(rc, "GET", `/reviews/${review_id}`)).status).toBe(404);
    expect((await h.call(s.cookie, "GET", `/reviews/${review_id}`)).status).toBe(200);

    // Deleted, the review still holds the rules it ran against.
    expect((await h.raw(s.cookie, "DELETE", `/playbooks/${s.playbook.id}`)).status).toBe(204);
    const kept = await h.call(s.cookie, "GET", `/reviews/${review_id}`);
    expect(kept.status).toBe(200);
    expect(kept.body.review.rules).toHaveLength(3);
    const exported = await h.raw(s.cookie, "POST", `/reviews/${review_id}/export`, {
      format: "xlsx",
    });
    expect(exported.status).toBe(200);
  });
});

describe("redline and export", () => {
  const comments = (bytes: Uint8Array) => {
    const xml = unzipSync(bytes)["word/comments.xml"];
    return xml ? [...strFromU8(xml).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]) : [];
  };

  it("writes one tracked change per applied suggestion, by Counsel, with its comment (WRD-002-b/c)", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sidOf(review, "Liability")}/apply`,
      {
        surface: "web",
        with_comment: true,
      },
    );
    await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sidOf(review, "Payment")}/dismiss`,
      {},
    );

    const res = await h.raw(s.cookie, "POST", `/reviews/${review_id}/redline`, {
      include_pending: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("msa (redline).docx");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const read = readDocx(bytes);
    // Deleted and inserted runs for the applied one only; the dismissed one left untouched.
    expect(read.existingEdits).toEqual([
      expect.objectContaining({ paragraph_index: 0, kind: "del", author: "Counsel" }),
      expect.objectContaining({ paragraph_index: 0, kind: "ins", author: "Counsel" }),
    ]);
    expect(read.paragraphs[0]?.text).toContain("is capped at the fees paid");
    expect(read.paragraphs[2]?.text).toBe(CLAUSES[2]);
    expect(comments(bytes)).toEqual([
      "Liability cap: Brings Liability cap to the standard position.",
    ]);
    const settings = strFromU8(unzipSync(bytes)["word/settings.xml"] ?? new Uint8Array());
    expect(settings).toContain("w:trackRevisions");

    // With pending included, the undecided ones come too; the dismissed one never does.
    const withPending = await h.raw(s.cookie, "POST", `/reviews/${review_id}/redline`, {
      include_pending: true,
    });
    const read2 = readDocx(new Uint8Array(await withPending.arrayBuffer()));
    expect(read2.existingEdits.filter((e) => e.kind === "ins")).toHaveLength(1);
    const actions = (await auditTrail(pool, s.m.workspaceId)).map((r) => r.action);
    expect(actions).toContain("review.redline_downloaded");

    if (process.env.SOFFICE_TEST === "1") {
      const dir = mkdtempSync(join(tmpdir(), "redline-"));
      try {
        writeFileSync(join(dir, "redline.docx"), bytes);
        execFileSync(
          "soffice",
          ["--headless", "--convert-to", "pdf", "--outdir", dir, join(dir, "redline.docx")],
          {
            stdio: "ignore",
            timeout: 120_000,
          },
        );
        expect(readFileSync(join(dir, "redline.pdf")).subarray(0, 4).toString()).toBe("%PDF");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("exports the summary as xlsx with Rules and Gaps sheets, and as docx (WRD-002-f)", async () => {
    const h = harness();
    const s = await setup(h);
    const { review_id } = await started(h, s);
    const review = await waitFor(h, s.cookie, review_id);
    await h.call(
      s.cookie,
      "POST",
      `/reviews/${review_id}/suggestions/${sidOf(review, "Liability")}/apply`,
      {
        surface: "web",
      },
    );
    const res = await h.raw(s.cookie, "POST", `/reviews/${review_id}/export`, { format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const workbook = strFromU8(files["xl/workbook.xml"] ?? new Uint8Array());
    expect([...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Rules", "Gaps"]);
    const cells = (name: string) =>
      [...strFromU8(files[name] ?? new Uint8Array()).matchAll(/<row r="(\d+)">(.*?)<\/row>/g)].map(
        (r) => [...(r[2] ?? "").matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((c) => c[1]),
      );
    const rules = cells("xl/worksheets/sheet1.xml");
    expect(rules[0]).toEqual([
      "Rule",
      "Status",
      "Clause reference",
      "Evidence quote",
      "Recommended language",
      "Justification",
      "Decision",
      "Decided by",
      "Decided at",
    ]);
    // One row per in-scope rule, in document order.
    expect(rules.slice(1).map((r) => r[0])).toEqual([
      "Liability cap",
      "Term length",
      "Payment terms",
    ]);
    expect(rules[1]?.[6]).toBe("applied");
    expect(rules[1]?.[7]).toBe(s.m.email);
    expect(cells("xl/worksheets/sheet2.xml")).toHaveLength(2);

    const docx = await h.raw(s.cookie, "POST", `/reviews/${review_id}/export`, { format: "docx" });
    const body = strFromU8(
      unzipSync(new Uint8Array(await docx.arrayBuffer()))["word/document.xml"] ?? new Uint8Array(),
    );
    expect(body).toContain("<w:tbl>");
    expect(body).toContain("Liability cap");
    const actions = (await auditTrail(pool, s.m.workspaceId)).map((r) => r.action);
    expect(actions.filter((a) => a === "review.exported")).toHaveLength(2);
  });
});
