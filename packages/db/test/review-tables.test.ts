import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("review tables", () => {
  it("never let a cell point at another table's row or column", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { tableId, columnId } = s.reviewTables.acme;
      const other = await tx.one<{ id: string }>(
        `insert into work.review_table (workspace_id, owner_id, name, source_kind)
         values ($1, $2, 'Other', 'uploads') returning id`,
        [s.acme, s.ana],
      );
      const row = await tx.one<{ id: string }>(
        `insert into work.rt_row (workspace_id, table_id, ordinal, document_ids)
         values ($1, $2, 0, array[$3::uuid]) returning id`,
        [s.acme, other.id, s.documents.acme.documentId],
      );
      // The other table's row, under this table's id and column.
      expect(
        await tx.error(
          `insert into work.rt_cell (workspace_id, table_id, row_id, column_id)
           values ($1, $2, $3, $4)`,
          [s.acme, tableId, row.id, columnId],
        ),
      ).toMatch(/rt_cell_row_in_table/);
    });
  });

  it("never let a citation or history entry name another table's cell", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { cellId } = s.reviewTables.acme;
      const other = await tx.one<{ id: string }>(
        `insert into work.review_table (workspace_id, owner_id, name, source_kind)
         values ($1, $2, 'Other', 'uploads') returning id`,
        [s.acme, s.ana],
      );
      expect(
        await tx.error(
          `insert into work.rt_cell_citation
             (workspace_id, table_id, cell_id, ordinal, version_id, quote, status)
           values ($1, $2, $3, 9, $4, 'q', 'unresolved')`,
          [s.acme, other.id, cellId, s.documents.acme.versionId],
        ),
      ).toMatch(/rt_cell_citation_cell_in_table/);
      expect(
        await tx.error(
          `insert into work.rt_cell_history (workspace_id, table_id, cell_id, actor_id, field)
           values ($1, $2, $3, $4, 'value')`,
          [s.acme, other.id, cellId, s.ana],
        ),
      ).toMatch(/rt_cell_history_cell_in_table/);
    });
  });

  it("keeps column references inside the table and free of cycles", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { tableId, columnId } = s.reviewTables.acme;
      const other = await tx.one<{ id: string }>(
        `insert into work.review_table (workspace_id, owner_id, name, source_kind)
         values ($1, $2, 'Other', 'uploads') returning id`,
        [s.acme, s.ana],
      );
      const add = (table: string, ordinal: number, depends: string[]) =>
        tx.one<{ id: string }>(
          `insert into work.rt_column (workspace_id, table_id, ordinal, label, type, prompt, depends_on)
           values ($1, $2, $3::int, 'Col ' || $3::text, 'free', 'p', $4::uuid[]) returning id`,
          [s.acme, table, ordinal, depends],
        );
      const b = await add(tableId, 5, [columnId]);
      const c = await add(tableId, 6, [b.id]);
      // The first column can't come to depend on the last: that would close a loop.
      expect(
        await tx.error("update work.rt_column set depends_on = $2::uuid[] where id = $1", [
          columnId,
          [c.id],
        ]),
      ).toMatch(/COLUMN_CYCLE/);
      expect(
        await tx.error("update work.rt_column set depends_on = $2::uuid[] where id = $1", [
          b.id,
          [b.id],
        ]),
      ).toMatch(/COLUMN_CYCLE/);
      // A column of another table, or one that doesn't exist, can't be referenced.
      const foreign = await add(other.id, 0, []);
      expect(
        await tx.error("update work.rt_column set depends_on = $2::uuid[] where id = $1", [
          c.id,
          [foreign.id],
        ]),
      ).toMatch(/COLUMN_REFERENCE_UNKNOWN/);
      expect(
        await tx.error(
          `update work.rt_column set depends_on = array['0194f3a0-0000-7000-8000-00000000dead']::uuid[]
            where id = $1`,
          [c.id],
        ),
      ).toMatch(/COLUMN_REFERENCE_UNKNOWN/);
    });
  });
});
