import type { Message } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail } from "../test-db.js";
import { addColumn, FEE, fakeModel, LAW, pool, rows, runAndWait, setup } from "./harness.js";

afterAll(() => pool.end());

const SUMMARY = "Law summary";

/** Answers "Law summary" from the earlier answer it is handed, and everything else as usual. */
function scripted(seen: string[]) {
  return (messages: readonly Message[]): string => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const label = /Column: (.+)/.exec(user)?.[1];
    if (label !== SUMMARY) return fakeModel(messages);
    seen.push(user);
    const earlier = /<answer-\w+ column="Governing law">\n([\s\S]*?)\n<\/answer-/.exec(user)?.[1];
    const passage = /<passage-\w+ doc="(D\d+)" page="(\d+)">\n([\s\S]*?)\n<\/passage/.exec(user);
    const quote = /[^.]*governed by[^.]*\./.exec(passage?.[3] ?? "")?.[0]?.trim();
    if (!earlier || !passage || !quote) {
      return JSON.stringify({ value: null, reasoning: "Nothing.", citations: [], not_found: true });
    }
    return JSON.stringify({
      value: `Governed by ${earlier}`,
      reasoning: "From the earlier answer.",
      citations: [{ doc: passage[1], page: Number(passage[2]), quote }],
      not_found: false,
    });
  };
}

type S = Awaited<ReturnType<typeof setup>>;

const summaryColumn = (lawId: string) => ({
  label: SUMMARY,
  type: "free",
  prompt: `State the position, given that the law is @{${lawId}}.`,
});

async function withLaw(seen: string[] = []) {
  const s = await setup({ model: scripted(seen) });
  const law = await addColumn(s, LAW);
  return { s, law, seen };
}

/** Every cell of a column by document name. */
async function column(s: S, columnId: string) {
  const page = await rows(s);
  const names = new Map<string, string>(
    page.rows.map((r: { id: string; documents: { name: string }[] }) => [
      r.id,
      r.documents[0]?.name ?? "",
    ]),
  );
  return Object.fromEntries(
    page.cells
      .filter((c: { column_id: string }) => c.column_id === columnId)
      .map((c: { row_id: string }) => [names.get(c.row_id), c]),
  ) as Record<
    string,
    {
      id: string;
      status: string;
      value_text: string | null;
      stale_since: string | null;
      verified_at: string | null;
    }
  >;
}

const call = (s: S, method: string, path: string, body?: unknown) =>
  s.h.call(s.cookie, method, `/review-tables/${s.tableId}${path}`, body);

describe("conditional columns (RVT-004)", () => {
  it("rejects a reference to a column that isn't there, and a column citing itself", async () => {
    const { s, law } = await withLaw();
    const unknown = await call(s, "POST", "/columns", {
      ...summaryColumn("0194f3a0-0000-7000-8000-00000000dead"),
    });
    expect(unknown).toMatchObject({ status: 400, body: { code: "INVALID_REQUEST" } });
    const self = await call(s, "PATCH", `/columns/${law}`, { prompt: `Same as @{${law}}` });
    expect(self).toMatchObject({ status: 409, body: { code: "COLUMN_CYCLE" } });
    expect(self.body.details.path).toEqual([law]);
  });

  it("refuses a cycle and names the path (RVT-004)", async () => {
    const { s, law } = await withLaw();
    const created = await call(s, "POST", "/columns", summaryColumn(law));
    expect(created.status).toBe(201);
    expect(created.body.column.depends_on).toEqual([law]);
    const summary = created.body.column.id as string;
    // The law column can't come to depend on the column that depends on it.
    const loop = await call(s, "PATCH", `/columns/${law}`, { prompt: `Given @{${summary}}` });
    expect(loop).toMatchObject({ status: 409, body: { code: "COLUMN_CYCLE" } });
    expect(loop.body.details.path).toEqual([summary, law]);
    const kept = await call(s, "GET", "");
    expect(kept.body.columns.find((c: { id: string }) => c.id === law).depends_on).toEqual([]);
  });

  it("won't delete a column other columns use", async () => {
    const { s, law } = await withLaw();
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    const refused = await call(s, "DELETE", `/columns/${law}`);
    expect(refused).toMatchObject({ status: 409, body: { code: "COLUMN_REFERENCED" } });
    expect(refused.body.details.dependents).toEqual([summary]);
    expect((await call(s, "DELETE", `/columns/${summary}`)).status).toBe(202);
    expect((await call(s, "DELETE", `/columns/${law}`)).status).toBe(202);
  });

  it("runs the columns a column uses first, and hands their answers to the model", async () => {
    const seen: string[] = [];
    const { s, law } = await withLaw(seen);
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    // Both are pending; the table run starts the dependency first, and the other waits for it.
    const run = await call(s, "POST", "/run", { scope: "pending" });
    expect(run.status).toBe(202);
    expect(run.body.run_ids).toHaveLength(2);
    await s.h.tables.runner.idle();
    const cells = await column(s, summary);
    expect(cells["credit.txt"]).toMatchObject({
      status: "done",
      value_text: "Governed by New York",
    });
    expect(cells["lease.txt"]).toMatchObject({
      status: "done",
      value_text: "Governed by England and Wales",
    });
    // The model saw the label in the question and the answer as fenced, uncitable data.
    expect(seen[0]).toContain(
      "Question: State the position, given that the law is [Governing law].",
    );
    expect(seen[0]).toMatch(/Earlier answers for these documents/);
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.some((e) => e.action === "table.column.added" && e.details.depends_on === 1)).toBe(
      true,
    );
  });

  it("blocks a cell whose dependency has no answer, and runs it once there is one", async () => {
    const seen: string[] = [];
    const { s, law } = await withLaw(seen);
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    // The dependency never ran: nothing to wait for, so the cells are blocked and no model is called.
    await runAndWait(s, summary);
    let cells = await column(s, summary);
    expect(Object.values(cells).map((c) => c.status)).toEqual(["blocked", "blocked"]);
    expect(seen).toHaveLength(0);
    // Once the dependency has answered, running what's pending picks the blocked cells up.
    await runAndWait(s, law);
    await runAndWait(s, summary, "pending");
    cells = await column(s, summary);
    expect(Object.values(cells).map((c) => c.status)).toEqual(["done", "done"]);
  });

  it("keeps a cell blocked when the answer it needs is null", async () => {
    const s = await setup({ model: scripted([]) });
    const fee = await addColumn(s, FEE);
    const column2 = await call(s, "POST", "/columns", {
      label: SUMMARY,
      type: "free",
      prompt: `Explain @{${fee}}`,
    });
    const next = column2.body.column.id as string;
    await runAndWait(s, fee);
    expect(Object.values(await column(s, fee)).map((c) => c.status)).toEqual(["null", "null"]);
    await runAndWait(s, next);
    expect(Object.values(await column(s, next)).map((c) => c.status)).toEqual([
      "blocked",
      "blocked",
    ]);
  });

  it("marks dependents stale when an answer they used changes (RVT-004)", async () => {
    const { s, law } = await withLaw();
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    await call(s, "POST", "/run", { scope: "pending" });
    await s.h.tables.runner.idle();
    const lawCells = await column(s, law);
    const edit = await call(s, "PATCH", `/cells/${lawCells["credit.txt"]?.id}`, {
      value_text: "Delaware",
    });
    expect(edit.status).toBe(200);
    const cells = await column(s, summary);
    // Refreshing only that cell: the dependent keeps its value and shows it is out of date.
    expect(cells["credit.txt"]).toMatchObject({
      status: "stale",
      value_text: "Governed by New York",
    });
    expect(cells["credit.txt"]?.stale_since).not.toBeNull();
    expect(cells["lease.txt"]?.status).toBe("done");
  });

  it("re-runs dependents after a cell when asked, skipping verified ones unless overridden", async () => {
    const seen: string[] = [];
    const { s, law } = await withLaw(seen);
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    await call(s, "POST", "/run", { scope: "pending" });
    await s.h.tables.runner.idle();
    const lawCells = await column(s, law);
    const before = seen.length;
    // Change the answer, then refresh the cell together with what depends on it.
    const lawCell = lawCells["credit.txt"]?.id;
    await call(s, "PATCH", `/cells/${lawCell}`, { value_text: "Delaware" });
    const summaryCell = (await column(s, summary))["credit.txt"]?.id;
    await call(s, "PATCH", `/cells/${summaryCell}`, { verified: true });
    const skipped = await call(s, "POST", `/cells/${lawCell}/rerun`, { include_dependents: true });
    expect(skipped.status).toBe(202);
    // The verified dependent is skipped by default, so no dependent run starts.
    expect(skipped.body.dependent_run_ids).toEqual([]);
    await s.h.tables.runner.idle();
    expect((await column(s, summary))["credit.txt"]).toMatchObject({ status: "stale" });
    expect((await column(s, summary))["credit.txt"]?.verified_at).not.toBeNull();
    expect(seen.length).toBe(before);
    // With the override it runs after the law cell, on the fresh answer, and loses its tick.
    await call(s, "PATCH", `/cells/${lawCell}`, { value_text: "Delaware" });
    const again = await call(s, "POST", `/cells/${lawCell}/rerun`, {
      include_dependents: true,
      include_verified: true,
    });
    expect(again.body.dependent_run_ids).toHaveLength(1);
    await s.h.tables.runner.idle();
    expect((await column(s, summary))["credit.txt"]).toMatchObject({
      status: "done",
      value_text: "Governed by New York",
      stale_since: null,
      verified_at: null,
    });
    expect(seen.length).toBeGreaterThan(before);
  });

  it("refreshes a column with its dependents in order", async () => {
    const seen: string[] = [];
    const { s, law } = await withLaw(seen);
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    await call(s, "POST", "/run", { scope: "pending" });
    await s.h.tables.runner.idle();
    const before = seen.length;
    const run = await call(s, "POST", `/columns/${law}/run`, {
      scope: "all",
      include_dependents: true,
    });
    expect(run.status).toBe(202);
    await s.h.tables.runner.idle();
    // The dependent column ran again over both rows, after the law cells were done.
    expect(seen.length).toBe(before + 2);
    expect(Object.values(await column(s, summary)).map((c) => c.status)).toEqual(["done", "done"]);
  });

  it("marks dependents stale when a column's prompt changes, and never re-runs them", async () => {
    const seen: string[] = [];
    const { s, law } = await withLaw(seen);
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    await call(s, "POST", "/run", { scope: "pending" });
    await s.h.tables.runner.idle();
    const before = seen.length;
    const edited = await call(s, "PATCH", `/columns/${law}`, { prompt: "Which law applies?" });
    expect(edited.body.stale_cells).toBe(4);
    expect(Object.values(await column(s, summary)).map((c) => c.status)).toEqual([
      "stale",
      "stale",
    ]);
    expect(seen.length).toBe(before);
  });

  it("cancelling a run that is waiting for its dependency puts its cells back", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = await setup({ model: scripted([]), hold });
    const law = await addColumn(s, LAW);
    const summary = (await call(s, "POST", "/columns", summaryColumn(law))).body.column.id;
    await call(s, "POST", "/run", { scope: "pending" });
    // The law cells wait on the model, so the summary run is waiting for them.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const waiting = await column(s, summary);
    expect(Object.values(waiting).map((c) => c.status)).toEqual(["blocked", "blocked"]);
    const col = (await call(s, "GET", "")).body.columns.find(
      (c: { id: string }) => c.id === summary,
    );
    expect(col.state).toBe("running");
    expect((await s.h.call(s.cookie, "POST", `/runs/${col.run_id}/cancel`)).status).toBe(202);
    release();
    await s.h.tables.runner.idle();
    expect(Object.values(await column(s, summary)).map((c) => c.status)).toEqual([
      "pending",
      "pending",
    ]);
  });
});
