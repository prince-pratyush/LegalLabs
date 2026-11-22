import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed, WORKFLOW_DEFINITION } from "./fixtures.js";

const allow = async (tx: Tx, user: string, permissions: string[]) => {
  await tx.asOwner();
  await tx.rows(`update core."user" set extra_permissions = $2 where id = $1`, [user, permissions]);
};

const titles = async (tx: Tx) =>
  (await tx.rows<{ title: string }>("select title from work.workflow order by title")).map(
    (r) => r.title,
  );

const level = async (tx: Tx, workflowId: string) =>
  (await tx.one<{ level: string | null }>("select work.workflow_level($1) as level", [workflowId]))
    .level;

const share = async (tx: Tx, s: Seed, workflowId: string, user: string, lvl: string) => {
  await tx.asOwner();
  await tx.rows(
    `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                   principal_id, level, granted_by)
     values ($1, 'workflow', $2, 'user', $3, $4, $5)`,
    [s.acme, workflowId, user, lvl, s.ana],
  );
};

// As the API writes one: the row, its first draft version, then the draft pointer.
async function create(tx: Tx, s: Seed, user: string) {
  // The id first: the read policy can't see a row in the statement that inserts it.
  const { id } = await tx.one<{ id: string }>("select core.uuid7() as id");
  await tx.rows(
    "insert into work.workflow (id, workspace_id, owner_id, title) values ($1, $2, $3, 'Lease review')",
    [id, s.acme, user],
  );
  const { id: versionId } = await tx.one<{ id: string }>(
    `insert into work.workflow_version (workspace_id, workflow_id, no, definition, created_by)
     values ($1, $2, 1, $3, $4) returning id`,
    [s.acme, id, WORKFLOW_DEFINITION, user],
  );
  await tx.rows("update work.workflow set draft_version_id = $2 where id = $1", [id, versionId]);
  return { id, versionId };
}

describe("workflows", () => {
  it("are their owner's until shared, and never cross workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben, ["agents.use", "agents.build"]);
      await allow(tx, s.cal, ["agents.use"]);
      await tx.as(s.ben, s.acme);
      const { id } = await create(tx, s, s.ben);
      expect(await titles(tx)).toEqual(["Lease review"]);
      expect(await level(tx, id)).toBe("full");

      await tx.as(s.cal, s.acme);
      expect(await titles(tx)).toEqual([]);
      await tx.as(s.bob, s.beta);
      expect(await titles(tx)).toEqual(["NDA summary"]);
      expect(await level(tx, id)).toBeNull();
      // agents.admin sees every workflow in its own workspace.
      await tx.as(s.ana, s.acme);
      expect(await titles(tx)).toEqual(["Lease review", "NDA summary"]);
    });
  });

  it("show runners the live version only, and let only editors change them", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { workflowId, versionId } = s.workflows.acme;
      await tx.as(s.ana, s.acme);
      const { id: draftId } = await tx.one<{ id: string }>(
        `insert into work.workflow_version (workspace_id, workflow_id, no, definition, created_by)
         values ($1, $2, 2, $3, $4) returning id`,
        [s.acme, workflowId, WORKFLOW_DEFINITION, s.ana],
      );
      await allow(tx, s.cal, ["agents.use"]);
      await share(tx, s, workflowId, s.cal, "run");

      await tx.as(s.cal, s.acme);
      expect(await level(tx, workflowId)).toBe("run");
      const versions = await tx.rows<{ id: string }>("select id from work.workflow_version");
      expect(versions.map((v) => v.id)).toEqual([versionId]);
      expect(versions).not.toContainEqual({ id: draftId });
      // A runner can't edit; the update simply finds no row.
      await tx.rows("update work.workflow set title = 'Hijacked' where id = $1", [workflowId]);
      expect(await titles(tx)).toEqual(["NDA summary"]);

      // An edit grant counts only with agents.build.
      await tx.asOwner();
      await tx.rows("delete from core.share_grant where object_id = $1", [workflowId]);
      await share(tx, s, workflowId, s.cal, "edit");
      await tx.as(s.cal, s.acme);
      expect(await level(tx, workflowId)).toBe("run");
      await allow(tx, s.cal, ["agents.use", "agents.build"]);
      await tx.as(s.cal, s.acme);
      expect(await level(tx, workflowId)).toBe("edit");
      await tx.rows("update work.workflow set title = 'NDA triage' where id = $1", [workflowId]);
      expect(await titles(tx)).toEqual(["NDA triage"]);
      // Deleting needs full.
      const { deleted } = await tx.one<{ deleted: boolean }>(
        "select work.delete_workflow($1) as deleted",
        [workflowId],
      );
      expect(deleted).toBe(false);
    });
  });

  it("need agents.use to see anything and agents.build to create", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await share(tx, s, s.workflows.acme.workflowId, s.ben, "full");
      await tx.as(s.ben, s.acme);
      expect(await titles(tx)).toEqual([]);
      expect(
        await tx.error(
          "insert into work.workflow (workspace_id, owner_id, title) values ($1, $2, 'X')",
          [s.acme, s.ben],
        ),
      ).toMatch(/row-level security/);
      // Guests never, whatever they hold.
      await allow(tx, s.gia, []);
      await tx.as(s.gia, s.acme);
      expect(await titles(tx)).toEqual([]);
    });
  });

  it("keep versions immutable and the definition's schema checked", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update work.workflow_version set no = 9 where id = $1", [
          s.workflows.acme.versionId,
        ]),
      ).toMatch(/permission denied/);
      await tx.asOwner();
      expect(
        await tx.error("update work.workflow_version set definition = '{}' where id = $1", [
          s.workflows.acme.versionId,
        ]),
      ).toMatch(/never change/);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          `insert into work.workflow_version (workspace_id, workflow_id, no, definition, created_by)
           values ($1, $2, 5, '{"schema": "other/1", "blocks": [], "edges": []}', $3)`,
          [s.acme, s.workflows.acme.workflowId, s.ana],
        ),
      ).toMatch(/check constraint/);
    });
  });

  it("soft delete through the owner only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { deleted } = await tx.one<{ deleted: boolean }>(
        "select work.delete_workflow($1) as deleted",
        [s.workflows.acme.workflowId],
      );
      expect(deleted).toBe(true);
      expect(await titles(tx)).toEqual([]);
      await tx.asOwner();
      const { n } = await tx.one<{ n: number }>(
        "select count(*)::int n from work.workflow where id = $1 and deleted_at is not null",
        [s.workflows.acme.workflowId],
      );
      expect(n).toBe(1);
    });
  });

  it("seed the catalogue idempotently, readable by every agents.use member, editable by none", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const items = (title: string) =>
        JSON.stringify([
          {
            key: "timeline",
            title,
            description: "Events",
            category: "General",
            definition: JSON.parse(WORKFLOW_DEFINITION),
          },
        ]);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("select work.seed_workflow_catalogue($1, $2)", [s.acme, items("T")]),
      ).toMatch(/permission denied/);

      await tx.asWorker();
      const seeded = await tx.one<{ n: number }>("select work.seed_workflow_catalogue($1, $2) n", [
        s.acme,
        items("Timeline"),
      ]);
      expect(seeded.n).toBe(1);
      const again = await tx.one<{ n: number }>("select work.seed_workflow_catalogue($1, $2) n", [
        s.acme,
        items("Timeline"),
      ]);
      expect(again.n).toBe(0);

      await allow(tx, s.cal, ["agents.use", "agents.build"]);
      await tx.as(s.cal, s.acme);
      const [row] = await tx.rows<{ id: string; title: string; status: string }>(
        "select id, title, status from work.workflow where catalogue",
      );
      expect(row).toMatchObject({ title: "Timeline", status: "live" });
      expect(await level(tx, row?.id as string)).toBe("view");
      await tx.rows("update work.workflow set title = 'Mine' where catalogue");
      expect(await titles(tx)).toEqual(["Timeline"]);
      expect(
        await tx.error(
          `insert into work.workflow_version (workspace_id, workflow_id, no, definition, created_by)
           values ($1, $2, 9, $3, $4)`,
          [s.acme, row?.id, WORKFLOW_DEFINITION, s.cal],
        ),
      ).toMatch(/row-level security/);
      // Even an admin can't publish over it or delete it.
      await tx.as(s.ana, s.acme);
      await tx.rows("update work.workflow set title = 'Mine' where catalogue");
      const { deleted } = await tx.one<{ deleted: boolean }>(
        "select work.delete_workflow($1) as deleted",
        [row?.id],
      );
      expect(deleted).toBe(false);
      // The other workspace has none until seeded there.
      await tx.as(s.bob, s.beta);
      expect((await tx.rows("select 1 from work.workflow where catalogue")).length).toBe(0);
    });
  });

  it("own embedded files: readers of the workflow see them, one owner per document", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { workflowId } = s.workflows.acme;
      await tx.as(s.ana, s.acme);
      const { id: docId } = await tx.one<{ id: string }>(
        `insert into content.document (workspace_id, owner_id, name, mime, size, workflow_id)
         values ($1, $2, 'Playbook.docx', 'application/zip', 10, $3) returning id`,
        [s.acme, s.ana, workflowId],
      );
      expect(
        await tx.error(
          `insert into content.document (workspace_id, owner_id, name, mime, size, workflow_id, vault_id)
           values ($1, $2, 'Both.docx', 'application/zip', 10, $3, $4)`,
          [s.acme, s.ana, workflowId, s.vaults.acme.vaultId],
        ),
      ).toMatch(/document_one_owner|row-level security/);
      await tx.asOwner();
      expect(
        await tx.error("update content.document set vault_id = $2 where id = $1", [
          docId,
          s.vaults.acme.vaultId,
        ]),
      ).toMatch(/document_one_owner/);

      const sees = async (user: string) => {
        await tx.as(user, s.acme);
        return (await tx.rows("select 1 from content.document where id = $1", [docId])).length;
      };
      await allow(tx, s.cal, ["agents.use", "threads.use"]);
      expect(await sees(s.cal)).toBe(0);
      await share(tx, s, workflowId, s.cal, "run");
      expect(await sees(s.cal)).toBe(1);
      // A runner can't upload into the workflow or remove its file.
      await tx.as(s.cal, s.acme);
      expect(
        await tx.error(
          `insert into content.document (workspace_id, owner_id, name, mime, size, workflow_id)
           values ($1, $2, 'Mine.docx', 'application/zip', 10, $3)`,
          [s.acme, s.cal, workflowId],
        ),
      ).toMatch(/row-level security/);
      const { removed } = await tx.one<{ removed: boolean }>(
        "select work.remove_workflow_file($1, $2) as removed",
        [workflowId, docId],
      );
      expect(removed).toBe(false);

      await tx.as(s.ana, s.acme);
      const done = await tx.one<{ removed: boolean }>(
        "select work.remove_workflow_file($1, $2) as removed",
        [workflowId, docId],
      );
      expect(done.removed).toBe(true);
      expect(await sees(s.ana)).toBe(0);
    });
  });
});
