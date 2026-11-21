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

  it("lets only a vault table sync, and only the worker list the tables due", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { tableId } = s.reviewTables.acme;
      // Fixture tables are over uploads, which can't sync.
      expect(
        await tx.error("update work.review_table set sync_mode = 'entire_vault' where id = $1", [
          tableId,
        ]),
      ).toMatch(/review_table_check/);
      const vault = await tx.one<{ id: string }>(
        `insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'V') returning id`,
        [s.acme, s.ana],
      );
      const synced = await tx.one<{ id: string }>(
        `insert into work.review_table
           (workspace_id, owner_id, name, source_kind, vault_id, sync_mode)
         values ($1, $2, 'Synced', 'vault', $3, 'entire_vault') returning id`,
        [s.acme, s.ana, vault.id],
      );
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select * from work.rt_sync_due()")).toMatch(/permission denied/);
      await tx.asOwner();
      await tx.asWorker();
      const due = await tx.rows<{ table_id: string; owner_id: string }>(
        "select table_id, owner_id from work.rt_sync_due()",
      );
      expect(due.map((d) => d.table_id)).toContain(synced.id);
      expect(due.find((d) => d.table_id === synced.id)?.owner_id).toBe(s.ana);
      // Only the tables with sync on are listed.
      expect(due.map((d) => d.table_id)).not.toContain(tableId);
    });
  });

  it("lets the owner flag a row whose file is out of sight", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { rowId, tableId } = s.reviewTables.acme;
      await tx.as(s.ana, s.acme);
      // The document drops out of the owner's view (here, moved to the bin).
      await tx.asOwner();
      await tx.rows(
        "update content.document set deleted_at = now(), deleted_reason = 'user' where id = any(select unnest(document_ids) from work.rt_row where id = $1)",
        [rowId],
      );
      await tx.as(s.ana, s.acme);
      const flagged = await tx.rows(
        "update work.rt_row set source_removed = true where id = $1 and table_id = $2 returning id",
        [rowId, tableId],
      );
      expect(flagged).toHaveLength(1);
    });
  });
});
