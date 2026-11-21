import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
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

  describe("templates", () => {
    // A member who may create tables but not manage the Library, like most authors.
    async function author(tx: Tx, ws: string) {
      const role = await tx.one<{ id: string }>(
        `insert into core.role (workspace_id, name, permissions)
         values ($1, 'Author', array['tables.create', 'threads.use']) returning id`,
        [ws],
      );
      return (
        await tx.one<{ id: string }>(
          `insert into core."user" (workspace_id, email, role_id, status) values ($1, 'amy@acme.test', $2, 'active')
           returning id`,
          [ws, role.id],
        )
      ).id;
    }
    const make = async (tx: Tx, ws: string, owner: string) => {
      await tx.as(owner, ws);
      return (
        await tx.one<{ id: string; status: string }>(
          `insert into work.rt_template (workspace_id, owner_id, name, columns)
           values ($1, $2, 'Lease terms', '[]') returning id, status`,
          [ws, owner],
        )
      ).id;
    };
    const sees = async (tx: Tx, user: string, ws: string, id: string) => {
      await tx.as(user, ws);
      return (await tx.rows("select id from work.rt_template where id = $1", [id])).length === 1;
    };

    it("is private until shared, and shared people can use it but not change it", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const amy = await author(tx, s.acme);
        const id = await make(tx, s.acme, amy);
        expect(await sees(tx, amy, s.acme, id)).toBe(true);
        expect(await sees(tx, s.ben, s.acme, id)).toBe(false);
        // The owner shares it: use lets ben see it, not edit it.
        await tx.as(amy, s.acme);
        const changes = await tx.rows<{ change: string }>(
          "select * from work.rt_template_set_shares($1, $2::jsonb)",
          [id, JSON.stringify([{ principal_type: "user", principal_id: s.ben, level: "use" }])],
        );
        expect(changes.map((c) => c.change)).toEqual(["added"]);
        expect(await sees(tx, s.ben, s.acme, id)).toBe(true);
        expect(await sees(tx, s.cal, s.acme, id)).toBe(false);
        expect(await sees(tx, s.bob, s.beta, id)).toBe(false);
        await tx.as(s.ben, s.acme);
        const edited = await tx.rows(
          "update work.rt_template set name = 'Mine' where id = $1 returning id",
          [id],
        );
        expect(edited).toHaveLength(0);
        // Only the owner (or library.manage) may share; ben can't pass it on.
        expect(
          await tx.error("select * from work.rt_template_set_shares($1, '[]'::jsonb)", [id]),
        ).toMatch(/FORBIDDEN/);
      });
    });

    it("moves through approval, and only library.manage decides", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const amy = await author(tx, s.acme);
        const id = await make(tx, s.acme, amy);
        const set = (status: string, note: string | null = null) =>
          tx.rows("select work.rt_template_set_status($1, $2, $3)", [id, status, note]);
        // Status never changes by a plain update.
        expect(
          await tx.error("update work.rt_template set status = 'published' where id = $1", [id]),
        ).toMatch(/permission denied/);
        // It has to be tested or shared before it can be sent for approval.
        expect(
          await tx.error("select work.rt_template_set_status($1, 'pending_approval')", [id]),
        ).toMatch(/BAD_TRANSITION/);
        await set("tested");
        await set("pending_approval");
        // The author can't approve her own template.
        expect(await tx.error("select work.rt_template_set_status($1, 'published')", [id])).toMatch(
          /FORBIDDEN/,
        );
        await tx.as(s.ana, s.acme);
        await set("rejected", "Too vague");
        const rejected = await tx.one<{ status: string; rejected_note: string }>(
          "select status, rejected_note from work.rt_template where id = $1",
          [id],
        );
        expect(rejected).toEqual({ status: "rejected", rejected_note: "Too vague" });
        await tx.as(amy, s.acme);
        await set("tested");
        await set("pending_approval");
        await tx.as(s.ana, s.acme);
        await set("published");
        // Published templates are open to every member of the workspace.
        expect(await sees(tx, s.cal, s.acme, id)).toBe(true);
        expect(await sees(tx, s.bob, s.beta, id)).toBe(false);
      });
    });

    it("lets the worker expire test tables after a week", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const old = await tx.one<{ id: string }>(
          `insert into work.review_table (workspace_id, owner_id, name, source_kind, is_test, created_at)
           values ($1, $2, 'Try-out', 'uploads', true, now() - interval '8 days') returning id`,
          [s.acme, s.ana],
        );
        const fresh = await tx.one<{ id: string }>(
          `insert into work.review_table (workspace_id, owner_id, name, source_kind, is_test)
           values ($1, $2, 'Try-out 2', 'uploads', true) returning id`,
          [s.acme, s.ana],
        );
        await tx.asWorker();
        expect((await tx.one<{ n: number }>("select work.rt_expire_tests() n")).n).toBe(1);
        await tx.asOwner();
        const gone = await tx.rows<{ id: string; deleted_at: Date | null }>(
          "select id, deleted_at from work.review_table where id = any($1::uuid[])",
          [[old.id, fresh.id]],
        );
        expect(gone.find((g) => g.id === old.id)?.deleted_at).not.toBeNull();
        expect(gone.find((g) => g.id === fresh.id)?.deleted_at).toBeNull();
      });
    });
  });
});
