import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const rules = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ title: `Rule ${i}`, standard_position: "x" })),
  );

const allow = async (tx: Tx, user: string, permissions: string[]) => {
  await tx.asOwner();
  await tx.rows(`update core."user" set extra_permissions = $2 where id = $1`, [user, permissions]);
};

const visible = async (tx: Tx) =>
  (await tx.rows<{ name: string }>("select name from work.playbook")).map((r) => r.name);

const level = async (tx: Tx, playbookId: string) =>
  (await tx.one<{ level: string | null }>("select work.playbook_level($1) as level", [playbookId]))
    .level;

const addVersion = (tx: Tx, s: Seed, user: string, no: number, body: string) =>
  tx.error(
    `insert into work.playbook_version
       (workspace_id, playbook_id, no, name, contract_type, rules, created_by)
     values ($1, $2, $3, 'NDA positions', 'NDA', $4, $5)`,
    [s.acme, s.playbooks.acme.playbookId, no, body, user],
  );

// A playbook written as `user` would through the API: the row, then its first version.
async function create(tx: Tx, s: Seed, user: string) {
  const { id } = await tx.one<{ id: string }>("select core.uuid7() as id");
  const { id: versionId } = await tx.one<{ id: string }>("select core.uuid7() as id");
  const row = await tx.error(
    `insert into work.playbook (id, workspace_id, owner_id, name, contract_type, version_id)
     values ($1, $2, $3, 'MSA positions', 'MSA', $4)`,
    [id, s.acme, user, versionId],
  );
  const version = await tx.error(
    `insert into work.playbook_version
       (id, workspace_id, playbook_id, no, name, contract_type, rules, created_by)
     values ($1, $2, $3, 1, 'MSA positions', 'MSA', '[]', $4)`,
    [versionId, s.acme, id, user],
  );
  return { id, error: row ?? version };
}

describe("playbooks", () => {
  it("keep an unpublished playbook to its editors, then show it to users once published", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { playbookId } = s.playbooks.acme;
      await allow(tx, s.cal, ["playbooks.use"]);
      // Ben's team has an edit grant, which counts only with playbooks.use.
      await tx.as(s.ben, s.acme);
      expect(await visible(tx)).toEqual([]);
      await allow(tx, s.ben, ["playbooks.use"]);

      await tx.as(s.ben, s.acme);
      expect(await visible(tx)).toEqual(["NDA positions"]);
      expect(await level(tx, playbookId)).toBe("edit");
      await tx.as(s.cal, s.acme);
      expect(await visible(tx)).toEqual([]);

      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          "update work.playbook set status = 'published', published_version_id = version_id",
        ),
      ).toBeUndefined();
      await tx.as(s.cal, s.acme);
      expect(await visible(tx)).toEqual(["NDA positions"]);
      expect(await level(tx, playbookId)).toBe("view");
      // threads.use alone is not playbooks.use.
      await tx.as(s.dee, s.acme);
      expect(await visible(tx)).toEqual([]);
      await tx.as(s.gia, s.acme);
      expect(await visible(tx)).toEqual([]);
    });
  });

  it("let an author draft and edit, but only an approver publish", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.cal, ["playbooks.use", "playbooks.create"]);
      await tx.as(s.cal, s.acme);
      const { id, error } = await create(tx, s, s.cal);
      expect(error).toBeUndefined();
      expect(await level(tx, id)).toBe("edit");
      expect(
        await tx.error(
          "update work.playbook set status = 'published', published_version_id = version_id where id = $1",
          [id],
        ),
      ).toMatch(/needs manage/);
      expect(
        await tx.error("update work.playbook set name = 'Renamed' where id = $1", [id]),
      ).toBeUndefined();

      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          "update work.playbook set status = 'published', published_version_id = version_id where id = $1",
          [id],
        ),
      ).toBeUndefined();
    });
  });

  it("refuse a playbook from someone without playbooks.create", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect((await create(tx, s, s.ben)).error).toMatch(/row-level security/);
    });
  });

  it("narrow a published playbook to its view grants when it has any", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.cal, ["playbooks.use"]);
      await allow(tx, s.dee, ["playbooks.use", "admin.users"]);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        "update work.playbook set status = 'published', published_version_id = version_id",
      );
      await tx.rows(
        `insert into work.playbook_grant
           (workspace_id, playbook_id, principal_type, principal_id, level, granted_by)
         values ($1, $2, 'group', $3, 'view', $4)`,
        [s.acme, s.playbooks.acme.playbookId, s.groups.litTeam, s.ana],
      );
      await tx.as(s.cal, s.acme);
      expect(await visible(tx)).toEqual(["NDA positions"]);
      await tx.as(s.dee, s.acme);
      expect(await visible(tx)).toEqual([]);
    });
  });

  it("let only a manager change grants", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const grant = (user: string) =>
        tx.error(
          `insert into work.playbook_grant
             (workspace_id, playbook_id, principal_type, principal_id, level, granted_by)
           values ($1, $2, 'user', $3, 'view', $4)`,
          [s.acme, s.playbooks.acme.playbookId, s.cal, user],
        );
      await tx.as(s.ben, s.acme);
      expect(await grant(s.ben)).toMatch(/row-level security/);
      await tx.as(s.ana, s.acme);
      expect(await grant(s.ana)).toBeUndefined();
      // A principal from another workspace is refused.
      expect(
        await tx.error(
          `insert into work.playbook_grant
             (workspace_id, playbook_id, principal_type, principal_id, level, granted_by)
           values ($1, $2, 'user', $3, 'view', $4)`,
          [s.acme, s.playbooks.acme.playbookId, s.bob, s.ana],
        ),
      ).toMatch(/not in this workspace/);
    });
  });

  it("show readers only the published version while editors work on a new one", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { playbookId, versionId } = s.playbooks.acme;
      await allow(tx, s.ben, ["playbooks.use"]);
      await allow(tx, s.cal, ["playbooks.use"]);
      await tx.as(s.ana, s.acme);
      await tx.rows("update work.playbook set status = 'published', published_version_id = $1", [
        versionId,
      ]);

      // Ben edits after publishing: a new version, made current for editors only.
      await tx.as(s.ben, s.acme);
      expect(await addVersion(tx, s, s.ben, 2, rules(3))).toBeUndefined();
      const { id: draft } = await tx.one<{ id: string }>(
        "select id from work.playbook_version where playbook_id = $1 and no = 2",
        [playbookId],
      );
      expect(
        await tx.error("update work.playbook set version_id = $1 where id = $2", [
          draft,
          playbookId,
        ]),
      ).toBeUndefined();
      expect(await tx.error("update work.playbook set published_version_id = version_id")).toMatch(
        /needs manage/,
      );
      expect((await tx.rows("select no from work.playbook_version")).length).toBe(2);

      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select no from work.playbook_version")).toEqual([{ no: 1 }]);
      // A published playbook always names its published version.
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update work.playbook set published_version_id = null")).toMatch(
        /check constraint/,
      );
    });
  });

  it("keep versions as written, with at most 200 rules and unique titles", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben, ["playbooks.use"]);
      await tx.as(s.ben, s.acme);
      expect(await addVersion(tx, s, s.ben, 2, rules(200))).toBeUndefined();
      expect(await addVersion(tx, s, s.ben, 3, rules(201))).toMatch(/check constraint/);
      const twice = JSON.stringify([
        { title: "Term", standard_position: "x" },
        { title: " term ", standard_position: "y" },
      ]);
      expect(await addVersion(tx, s, s.ben, 3, twice)).toMatch(/check constraint/);
      expect(await tx.error("update work.playbook_version set rules = '[]'")).toMatch(
        /permission denied/,
      );
      expect(await tx.error("delete from work.playbook_version")).toMatch(/permission denied/);
      await tx.as(s.cal, s.acme);
      expect(await addVersion(tx, s, s.cal, 3, rules(1))).toMatch(/row-level security/);
    });
  });

  it("hide a deleted playbook, and let only a manager delete", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const remove = async () =>
        (
          await tx.one<{ ok: boolean }>("select work.delete_playbook($1) as ok", [
            s.playbooks.acme.playbookId,
          ])
        ).ok;
      await tx.as(s.ben, s.acme);
      expect(await remove()).toBe(false);
      expect(await tx.error("update work.playbook set deleted_at = now()")).toMatch(
        /permission denied/,
      );
      await tx.as(s.ana, s.acme);
      expect(await remove()).toBe(true);
      expect(await visible(tx)).toEqual([]);
    });
  });
});
