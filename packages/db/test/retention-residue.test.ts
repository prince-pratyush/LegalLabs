import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

/*
 * Pen-test P-03 (SEC-029, ADM-004): after retention purges an object, no row anywhere may still
 * name it. The scan below reads every table as the schema owner, so no policy can hide a leftover.
 */

const SCHEMAS = ["core", "work", "content", "admin", "knowledge", "notify", "analytics"].concat([
  "retention",
  "memory",
  "library",
  "scim",
  "apps",
]);

// Meant to outlive the object: the audit trail, and retention's own record of what it did.
const KEPT = new Set([
  "admin.audit_event",
  "admin.audit_anchor",
  "retention.recycle_bin",
  "retention.deletion_job",
  "retention.hold",
]);

async function residue(tx: Tx, ids: string[]): Promise<string[]> {
  await tx.asOwner();
  const tables = await tx.rows<{ t: string }>(
    `select format('%I.%I', n.nspname, c.relname) as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any ($1)
      order by 1`,
    [SCHEMAS],
  );
  const found: string[] = [];
  for (const { t } of tables) {
    if (KEPT.has(t)) continue;
    for (const id of ids) {
      const rows = await tx.rows<{ n: string }>(
        `select count(*) as n from ${t} x where x::text like $1`,
        [`%${id}%`],
      );
      if (Number(rows[0]?.n) > 0) found.push(`${t} still mentions ${id}`);
    }
  }
  return found;
}

// Expired and binned long ago, so the next sweep purges it.
async function expire(tx: Tx, workspace: string, type: string, id: string, label: string) {
  await tx.rows(
    `insert into retention.recycle_bin (workspace_id, object_type, object_id, label, restorable_until)
     values ($1, $2, $3, $4, now() - interval '1 day')`,
    [workspace, type, id, label],
  );
}

describe("P-03 retention leaves no residue", () => {
  it("purges a thread with its notifications, queued mail and everything under it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const t = s.threads.acme;
      await tx.asOwner();
      // What sharing a thread really sends: a notification, and mail that carries its title.
      const note = await tx.one<{ id: string }>(
        `insert into notify.notification (workspace_id, user_id, kind, category, object_type, object_id, title, url)
         values ($1, $2, 'thread.shared', 'threads', 'thread', $3, 'A thread was shared with you: Falcon bid', '#/t/x')
         returning id`,
        [s.acme, s.ben, t.threadId],
      );
      await tx.rows(
        `insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload)
         values ($1, $2, 'threads', 'b1', $3::jsonb)`,
        [
          s.acme,
          s.ben,
          JSON.stringify({ items: [{ id: note.id, object_id: t.threadId, title: "Falcon bid" }] }),
        ],
      );
      await tx.rows(
        "update work.thread set deleted_at = now() - interval '31 days' where id = $1",
        [t.threadId],
      );
      await expire(tx, s.acme, "thread", t.threadId, "Falcon bid");
      await tx.rows("select retention.sweep_all()");
      expect(
        await residue(tx, [t.threadId, t.messageId, t.runId, t.draftId, t.outputId, note.id]),
      ).toEqual([]);
    });
  });

  it("purges a review table with the notifications that named it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = s.reviewTables.acme;
      await tx.asOwner();
      await tx.rows(
        `insert into notify.notification (workspace_id, user_id, kind, category, object_type, object_id, title, url)
         values ($1, $2, 'rt.shared', 'tables', 'review_table', $3, 'A review table was shared with you: Deal review', '#/r/x')`,
        [s.acme, s.ben, r.tableId],
      );
      await tx.rows(
        "update work.review_table set deleted_at = now() - interval '31 days' where id = $1",
        [r.tableId],
      );
      await expire(tx, s.acme, "review_table", r.tableId, "Deal review");
      await tx.rows("select retention.sweep_all()");
      expect(await residue(tx, [r.tableId, r.rowId, r.columnId, r.cellId])).toEqual([]);
    });
  });

  it("purges a document with its pages, chunks, blob, versions and ingest jobs", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = s.vaults.acme;
      await tx.asOwner();
      await tx.rows(
        `update content.document set deleted_at = now() - interval '31 days', deleted_reason = 'retention'
          where id = $1`,
        [d.documentId],
      );
      await expire(tx, s.acme, "document", d.documentId, "nda.txt");
      await tx.rows("select retention.sweep_all()");
      expect(await residue(tx, [d.documentId])).toEqual([]);
    });
  });

  it("purges an intake attachment with the row that named it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { documentId } = s.intakes.acme;
      await tx.asOwner();
      await tx.rows(
        `update content.document set deleted_at = now() - interval '31 days', deleted_reason = 'retention'
          where id = $1`,
        [documentId],
      );
      await expire(tx, s.acme, "document", documentId, "in.txt");
      await tx.rows("select retention.sweep_all()");
      expect(await residue(tx, [documentId])).toEqual([]);
    });
  });
});
