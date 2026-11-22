import type { Message } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it, vi } from "vitest";
import { auditTrail } from "../test-db.js";
import {
  addColumn,
  DATE,
  fakeModel,
  LEASE,
  pool,
  rows,
  runAndWait,
  setup,
} from "../test-tables.js";

afterAll(() => pool.end());
vi.setConfig({ testTimeout: 90_000 });

type S = Awaited<ReturnType<typeof setup>>;

const call = (s: S, method: string, path: string, body?: unknown) =>
  s.h.call(s.cookie, method, `/review-tables/${s.tableId}${path}`, body);

const names = async (s: S) =>
  (await rows(s)).rows.map((r: { documents: { name: string }[] }) => r.documents[0]?.name);

describe("rows", () => {
  it("flags and locks a row, and a locked row takes no flag", async () => {
    const s = await setup();
    const row = (await rows(s)).rows[0];
    const flagged = await call(s, "PATCH", `/rows/${row.id}`, { flag_color: "red" });
    expect(flagged.body.row).toMatchObject({ id: row.id, flag_color: "red", locked: false });
    const locked = await call(s, "PATCH", `/rows/${row.id}`, { locked: true });
    expect(locked.body.row.locked).toBe(true);
    expect(await call(s, "PATCH", `/rows/${row.id}`, { flag_color: "blue" })).toMatchObject({
      status: 409,
      body: { code: "CELL_LOCKED" },
    });
    const unlocked = await call(s, "PATCH", `/rows/${row.id}`, { locked: false, flag_color: null });
    expect(unlocked.body.row).toMatchObject({ locked: false, flag_color: null });
    expect((await call(s, "PATCH", `/rows/${row.id}`, {})).status).toBe(400);
    expect((await call(s, "PATCH", "/rows/not-an-id", { flag_color: "red" })).status).toBe(404);
    const trail = await auditTrail(pool, s.m.workspaceId);
    for (const action of ["table.row.flagged", "table.row.locked", "table.row.unlocked"]) {
      expect(trail.some((e) => e.action === action)).toBe(true);
    }
  });

  it("keeps a locked row's cells from being edited, even in a request that unlocks the cell", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    await runAndWait(s, date);
    const page = await rows(s);
    const row = page.rows[0];
    const cell = page.cells.find((c: { row_id: string }) => c.row_id === row.id);
    await call(s, "PATCH", `/rows/${row.id}`, { locked: true });
    for (const body of [
      { value_text: "1 January 2000" },
      { value_text: "1 January 2000", locked: false },
      { verified: true, locked: false },
      { flag_color: "red", locked: false },
    ]) {
      expect(await call(s, "PATCH", `/cells/${cell.id}`, body)).toMatchObject({
        status: 409,
        body: { code: "CELL_LOCKED" },
      });
    }
    const { rows: stored } = await pool.query(
      "select value_text, verified_at, flag_color from work.rt_cell where id = $1",
      [cell.id],
    );
    expect(stored[0]).toMatchObject({
      value_text: cell.value_text,
      verified_at: null,
      flag_color: null,
    });
    // Once the row is unlocked the cell takes edits again.
    await call(s, "PATCH", `/rows/${row.id}`, { locked: false });
    expect(await call(s, "PATCH", `/cells/${cell.id}`, { flag_color: "red" })).toMatchObject({
      status: 200,
    });
  });

  it("deletes rows, keeping a locked one", async () => {
    const s = await setup();
    const [first, second] = (await rows(s)).rows;
    await call(s, "PATCH", `/rows/${second.id}`, { locked: true });
    const removed = await call(s, "DELETE", "/rows", { row_ids: [first.id, second.id] });
    expect(removed).toMatchObject({ status: 202, body: { deleted: 1, skipped: 1 } });
    expect(await names(s)).toEqual([second.documents[0].name]);
    expect((await call(s, "GET", "")).body.table.stats.rows).toBe(1);
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.find((e) => e.action === "table.rows.deleted")?.details).toEqual({
      rows: 1,
      skipped: 1,
    });
  });
});

describe("rows on a synced table", () => {
  it("won't delete a row while sync is on, as sync would add its file straight back", async () => {
    const s = await setup();
    await call(s, "PUT", "/sync", { mode: "entire_vault" });
    const row = (await rows(s)).rows[0];
    expect(await call(s, "DELETE", "/rows", { row_ids: [row.id] })).toMatchObject({
      status: 409,
      body: { code: "SYNC_ENABLED" },
    });
  });
});

describe("column context file", () => {
  it("puts the context file in every cell's prompt, uncitable and within its share", async () => {
    const seen: string[] = [];
    const model = (messages: readonly Message[]) => {
      seen.push(messages.find((m) => m.role === "user")?.content ?? "");
      return fakeModel(messages);
    };
    const s = await setup({ model });
    const lease = (await rows(s)).rows.find(
      (r: { documents: { name: string }[] }) => r.documents[0]?.name === "lease.txt",
    ).documents[0].id as string;
    const column = await addColumn(s, { ...DATE, context_document_id: lease });
    await runAndWait(s, column);
    expect(seen).toHaveLength(2);
    for (const user of seen) {
      expect(user).toMatch(/Context file \(code \w+\): lease\.txt/);
      expect(user).toContain(LEASE.slice(0, 40));
    }
    // The credit agreement's own answer still comes from its own text.
    const cells = (await rows(s)).cells as { status: string; value_text: string }[];
    expect(cells.map((c) => c.status)).toEqual(["done", "done"]);
    expect(cells.map((c) => c.value_text).sort()).toEqual(["2023-06-05", "2024-03-01"]);
  });

  it("goes without when the column has no context file", async () => {
    const seen: string[] = [];
    const s = await setup({
      model: (messages) => {
        seen.push(messages.find((m) => m.role === "user")?.content ?? "");
        return fakeModel(messages);
      },
    });
    await runAndWait(s, await addColumn(s, DATE));
    expect(seen.some((u) => u.includes("Context file"))).toBe(false);
  });
});
