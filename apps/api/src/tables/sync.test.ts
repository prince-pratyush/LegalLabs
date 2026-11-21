import { randomBytes } from "node:crypto";
import type { SyncAddedRowsEvent } from "@legallabs/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail } from "../test-db.js";
import {
  AMOUNT,
  addColumn,
  DATE,
  FEE,
  type HarnessOptions,
  LAW,
  pool,
  rows,
  runAndWait,
  setup,
} from "./harness.js";

afterAll(() => pool.end());

const GONE = "0194f3a0-0000-7000-8000-00000000dead";
const LOAN =
  "This Loan Agreement is dated 9 January 2025 between the Lender and the Borrower. The aggregate commitments are USD 2 million. This Agreement is governed by the laws of the State of New York.";

type S = Awaited<ReturnType<typeof setup>>;

const call = (s: S, method: string, path: string, body?: unknown) =>
  s.h.call(s.cookie, method, `/review-tables/${s.tableId}${path}`, body);

/** Every cell of a table by document name and column label. */
async function grid(s: S) {
  const [page, meta] = await Promise.all([rows(s), call(s, "GET", "")]);
  const labels = new Map<string, string>(
    meta.body.columns.map((c: { id: string; label: string }) => [c.id, c.label]),
  );
  const names = new Map<string, string>(
    page.rows.map((r: { id: string; documents: { name: string }[]; version_no?: number }) => [
      r.id,
      r.documents[0]?.name ?? "",
    ]),
  );
  const out: Record<string, Record<string, { status: string; value_text: string | null }>> = {};
  for (const c of page.cells as {
    row_id: string;
    column_id: string;
    status: string;
    value_text: string | null;
  }[]) {
    const row = names.get(c.row_id) ?? "?";
    out[row] ??= {};
    (out[row] as Record<string, unknown>)[labels.get(c.column_id) ?? "?"] = c;
  }
  return { out, page };
}

/** A table that has run three columns over two files, with a fourth that never has. */
async function synced(events: SyncAddedRowsEvent[] = []) {
  const s = await setup({ syncEvents: (e) => void events.push(e) });
  for (const column of [DATE, AMOUNT, LAW]) await runAndWait(s, await addColumn(s, column));
  await addColumn(s, FEE); // never run: sync must leave it for the user
  return s;
}

const enable = (s: S, body: object = { mode: "entire_vault" }) => call(s, "PUT", "/sync", body);

/** Uploads one more file to the vault, read at once like the ingestion worker would. */
async function upload(s: S, name: string, text: string) {
  const form = new FormData();
  form.set("file", new File([text], name));
  const res = await s.h.app.request(`/api/v1/vaults/${s.v.id}/files`, {
    method: "POST",
    headers: { cookie: s.cookie },
    body: form,
  });
  return ((await res.json()) as { file: { id: string } }).file.id;
}

describe("vault sync (RVT-007)", () => {
  it("adds rows for new files and runs the columns that have run before", async () => {
    const events: SyncAddedRowsEvent[] = [];
    const s = await synced(events);
    expect((await enable(s, { mode: "entire_vault", notify: true })).body).toMatchObject({
      mode: "entire_vault",
      state: "idle",
      notify: true,
      pending_rows: 0,
    });
    await upload(s, "loan.txt", LOAN);

    // The background job's pass: one new row, the three columns that have run started on it.
    expect(await s.h.tables.sync.runDue(s.m.workspaceId)).toBe(1);
    await s.h.tables.runner.idle();

    const { out, page } = await grid(s);
    expect(page.rows).toHaveLength(3);
    expect(out["loan.txt"]).toMatchObject({
      Date: { status: "done", value_text: "2025-01-09" },
      Amount: { status: "done" },
      "Governing law": { status: "done" },
      // A column that has never run is left for the user to start.
      "Termination fee": { status: "pending" },
    });
    // Rows that were there already weren't touched.
    expect(out["credit.txt"]?.Date?.status).toBe("done");

    const status = await call(s, "GET", "/sync");
    expect(status.body).toMatchObject({ mode: "entire_vault", state: "idle", pending_rows: 0 });
    expect(status.body.last_synced_at).not.toBeNull();

    // The owner opted in, so the notification event went out once, with counts and no values.
    expect(events).toEqual([
      {
        type: "table.sync_added_rows",
        workspace_id: s.m.workspaceId,
        user_id: s.m.userId,
        table_id: s.tableId,
        table_name: "Deal review",
        rows: 1,
      },
    ]);
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.some((e) => e.action === "table.sync.enabled")).toBe(true);
    expect(trail.find((e) => e.action === "table.sync.rows_added")?.details).toEqual({
      rows: 1,
      new_versions: 0,
    });
  });

  it("doesn't notify unless the owner opted in", async () => {
    const events: SyncAddedRowsEvent[] = [];
    const s = await synced(events);
    await enable(s);
    await upload(s, "loan.txt", LOAN);
    await s.h.tables.sync.runDue(s.m.workspaceId);
    await s.h.tables.runner.idle();
    expect(events).toEqual([]);
  });

  it("shows the sync as pending while new rows run, then idle", async () => {
    // The model is held back only after the first columns have run, so the new row's cells wait.
    const options: HarnessOptions = {};
    const s = await setup(options);
    await runAndWait(s, await addColumn(s, DATE));
    await enable(s);
    let release = () => {};
    options.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await upload(s, "loan.txt", LOAN);
    await call(s, "POST", "/sync/run");
    expect((await call(s, "GET", "/sync")).body).toMatchObject({
      state: "pending",
      pending_rows: 1,
    });
    release();
    await s.h.tables.runner.idle();
    expect((await call(s, "GET", "/sync")).body).toMatchObject({ state: "idle", pending_rows: 0 });
  });

  it("runs sync now on request, and refuses manual rows while it is on (RVT-007)", async () => {
    const s = await synced();
    const other = await upload(s, "extra.txt", LOAN);
    await enable(s);
    const manual = await call(s, "POST", "/rows", { document_ids: [other] });
    expect(manual).toMatchObject({ status: 409, body: { code: "SYNC_ENABLED" } });
    const ran = await call(s, "POST", "/sync/run");
    expect(ran).toMatchObject({
      status: 200,
      body: { added_rows: 1, new_versions: 0, removed_rows: 0, runs: 3 },
    });
    await s.h.tables.runner.idle();
    // A second pass finds nothing new.
    expect((await call(s, "POST", "/sync/run")).body).toMatchObject({ added_rows: 0, runs: 0 });
    // With sync off, rows can be added again.
    await call(s, "PUT", "/sync", { mode: "off" });
    expect((await call(s, "GET", "/sync")).body).toMatchObject({ mode: "off", state: "off" });
    const again = await upload(s, "again.txt", LOAN);
    expect((await call(s, "POST", "/rows", { document_ids: [again] })).status).toBe(201);
  });

  it("flags rows whose file left the vault, refuses to re-run them, and restores the flag", async () => {
    const s = await synced();
    await enable(s);
    const trash = (path: string) =>
      s.h.call(s.cookie, "POST", `/vaults/${s.v.id}/${path}`, { document_ids: [s.v.ids[1]] });
    expect((await trash("trash")).status).toBe(200);
    const pass = await call(s, "POST", "/sync/run");
    expect(pass.body.removed_rows).toBe(1);
    // The row is gone from view while the file is in the bin; once back, it is flagged again clear.
    expect((await call(s, "GET", "/sync")).body.removed_rows).toBe(1);
    expect((await trash("restore")).status).toBe(200);
    const back = await call(s, "POST", "/sync/run");
    expect(back.body).toMatchObject({ restored_rows: 1, removed_rows: 0, added_rows: 0 });
    expect((await call(s, "GET", "/sync")).body.removed_rows).toBe(0);
  });

  it("makes a new row for a new version and leaves the old row and its verified cells (RVT-007)", async () => {
    const s = await synced();
    await enable(s);
    const before = await grid(s);
    const creditRow = before.page.rows.find(
      (r: { documents: { name: string }[] }) => r.documents[0]?.name === "credit.txt",
    );
    const cell = before.page.cells.find(
      (c: { row_id: string; status: string }) => c.row_id === creditRow.id && c.status === "done",
    );
    await call(s, "PATCH", `/cells/${cell.id}`, { verified: true });

    // A second version of credit.txt, read and ready like the ingestion worker leaves it.
    const documentId = creditRow.documents[0].id as string;
    const version = await pool.query<{ id: string }>(
      `insert into content.document_version
         (workspace_id, document_id, version_no, sha256, page_count, created_by)
       values ($1, $2, 2, $3, 1, $4) returning id`,
      [s.m.workspaceId, documentId, randomBytes(32), s.m.userId],
    );
    await pool.query(
      `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
       values ($1, $2, 1, 100, 100, $3, '{"blocks": []}')`,
      [
        s.m.workspaceId,
        version.rows[0]?.id,
        "This Credit Agreement is dated 2 April 2025 between the Borrower and the Lenders. The aggregate commitments are USD 3 million. This Agreement is governed by the laws of England and Wales.",
      ],
    );
    const pass = await call(s, "POST", "/sync/run");
    expect(pass.body).toMatchObject({ added_rows: 1, new_versions: 1 });
    await s.h.tables.runner.idle();

    const after = await grid(s);
    const credit = after.page.rows.filter(
      (r: { documents: { name: string }[] }) => r.documents[0]?.name === "credit.txt",
    );
    expect(credit).toHaveLength(2);
    const [v1, v2] = credit.sort(
      (a: { ordinal: number }, b: { ordinal: number }) => a.ordinal - b.ordinal,
    );
    expect(v1).toMatchObject({ version_no: 1, newer_version: true });
    expect(v2).toMatchObject({ version_no: 2, newer_version: false });
    const cellsOf = (id: string) =>
      after.page.cells.filter((c: { row_id: string }) => c.row_id === id);
    // The version-1 row keeps its answer and its tick; the new row read the new text.
    expect(cellsOf(v1.id).find((c: { id: string }) => c.id === cell.id)).toMatchObject({
      status: "done",
      value_text: cell.value_text,
    });
    expect(cellsOf(v1.id).find((c: { id: string }) => c.id === cell.id).verified_at).not.toBeNull();
    expect(
      cellsOf(v2.id).find((c: { value_text: string }) => c.value_text === "2025-04-02"),
    ).toBeTruthy();
  });

  it("syncs only the chosen folders", async () => {
    const s = await synced();
    const folder = (
      await s.h.call(s.cookie, "POST", `/vaults/${s.v.id}/folders`, { name: "Loans" })
    ).body.folder.id as string;
    const form = new FormData();
    form.set("file", new File([LOAN], "in-folder.txt"));
    form.set("folder_id", folder);
    await s.h.app.request(`/api/v1/vaults/${s.v.id}/files`, {
      method: "POST",
      headers: { cookie: s.cookie },
      body: form,
    });
    await upload(s, "outside.txt", LOAN);
    expect(await enable(s, { mode: "selected_folders", folder_ids: [GONE] })).toMatchObject({
      status: 400,
      body: { code: "SOURCE_MISMATCH" },
    });
    expect((await enable(s, { mode: "selected_folders", folder_ids: [folder] })).status).toBe(200);
    const pass = await call(s, "POST", "/sync/run");
    expect(pass.body.added_rows).toBe(1);
    const names = (await rows(s)).rows.map(
      (r: { documents: { name: string }[] }) => r.documents[0]?.name,
    );
    expect(names).toContain("in-folder.txt");
    expect(names).not.toContain("outside.txt");
  });

  it("refuses to re-run a row whose file has left the vault", async () => {
    const s = await synced();
    const page = await rows(s);
    const row = page.rows[0];
    await pool.query("update work.rt_row set source_removed = true where id = $1", [row.id]);
    const cell = (await rows(s)).cells.find((c: { row_id: string }) => c.row_id === row.id);
    expect(await call(s, "POST", `/cells/${cell.id}/rerun`)).toMatchObject({
      status: 409,
      body: { code: "SOURCE_REMOVED" },
    });
    const meta = await call(s, "GET", "");
    const column = meta.body.columns[0].id as string;
    // The column run covers the other row only; this one keeps what it has.
    const run = await call(s, "POST", `/columns/${column}/run`, { scope: "all" });
    expect(run.body.cells).toBe(1);
    await s.h.tables.runner.idle();
    expect((await rows(s)).rows.find((r: { id: string }) => r.id === row.id).source_removed).toBe(
      true,
    );
  });

  it("validates the sync settings and who may change them", async () => {
    const s = await synced();
    expect(await enable(s, { mode: "selected_folders" })).toMatchObject({ status: 400 });
    expect(await enable(s, { mode: "entire_vault", folder_ids: [GONE] })).toMatchObject({
      status: 400,
    });
    expect((await call(s, "POST", "/sync/run")).body.code).toBe("SYNC_DISABLED");
    // A table made from loose uploads has no sync.
    const doc = await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}`);
    expect(doc.body.table.source_kind).toBe("vault");
  });
});
