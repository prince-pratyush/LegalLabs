import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

const SHA = "a".repeat(64);

async function prompt(tx: Tx, s: Seed, owner: string, name = "NDA review") {
  await tx.as(owner, s.acme);
  return (
    await tx.one<{ id: string }>(
      `insert into library.prompt (workspace_id, owner_id, name, body)
       values ($1, $2, $3, 'Review {{contract}}') returning id`,
      [s.acme, owner, name],
    )
  ).id;
}

async function template(tx: Tx, s: Seed) {
  await tx.as(s.ana, s.acme);
  const { id } = await tx.one<{ id: string }>(
    `insert into library.template (workspace_id, owner_id, name) values ($1, $2, 'Letterhead')
     returning id`,
    [s.acme, s.ana],
  );
  await tx.rows(
    `insert into library.template_version (workspace_id, template_id, no, file_name, bytes, sha256, created_by)
     values ($1, $2, 1, 'firm.docx', '\\x504b', $3, $4)`,
    [s.acme, id, SHA, s.ana],
  );
  return id;
}

const share = (tx: Tx, kind: string, id: string, grants: unknown[]) =>
  tx.rows<{ principal_type: string; principal_id: string; level: string; change: string }>(
    "select * from library.set_shares($1, $2, $3::jsonb)",
    [kind, id, JSON.stringify(grants)],
  );

const sees = async (tx: Tx, user: string, ws: string, table: string, id: string) => {
  await tx.as(user, ws);
  return (await tx.rows(`select id from library.${table} where id = $1`, [id])).length === 1;
};

describe("saved prompts", () => {
  it("are private to their owner and library.manage", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await prompt(tx, s, s.ben);
      expect(await sees(tx, s.ben, s.acme, "prompt", id)).toBe(true);
      expect(await sees(tx, s.cal, s.acme, "prompt", id)).toBe(false);
      expect(await sees(tx, s.ana, s.acme, "prompt", id)).toBe(true);
      expect(await sees(tx, s.bob, s.beta, "prompt", id)).toBe(false);
    });
  });

  it("need threads.use, and can't be made for someone else", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      expect(
        await tx.error(
          "insert into library.prompt (workspace_id, owner_id, name, body) values ($1, $2, 'x', 'y')",
          [s.acme, s.gia],
        ),
      ).toMatch(/row-level security/);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          "insert into library.prompt (workspace_id, owner_id, name, body) values ($1, $2, 'x', 'y')",
          [s.acme, s.cal],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("are shared by group, at use or edit, and only through set_shares", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await prompt(tx, s, s.ben);
      expect(
        await tx.error(
          `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                         principal_id, level, granted_by)
           values ($1, 'library_item', $2, 'group', $3, 'view', $4)`,
          [s.acme, id, s.groups.litTeam, s.ben],
        ),
      ).toMatch(/row-level security/);

      await tx.as(s.ben, s.acme);
      expect(
        await share(tx, "prompt", id, [
          { principal_type: "group", principal_id: s.groups.litTeam, level: "use" },
        ]),
      ).toEqual([
        { principal_type: "group", principal_id: s.groups.litTeam, level: "use", change: "added" },
      ]);
      expect(await sees(tx, s.cal, s.acme, "prompt", id)).toBe(true);
      // Use only: Cal's update touches nothing.
      expect(
        await tx.rows("update library.prompt set name = 'mine' where id = $1 returning id", [id]),
      ).toEqual([]);

      await tx.as(s.ben, s.acme);
      expect(
        await share(tx, "prompt", id, [
          { principal_type: "group", principal_id: s.groups.litTeam, level: "edit" },
        ]),
      ).toEqual([
        {
          principal_type: "group",
          principal_id: s.groups.litTeam,
          level: "edit",
          change: "changed",
        },
      ]);
      await tx.as(s.cal, s.acme);
      expect(
        await tx.rows("update library.prompt set name = 'better' where id = $1 returning id", [id]),
      ).toHaveLength(1);
      // Editors can't delete, or move the prompt to themselves.
      expect(await tx.rows("delete from library.prompt where id = $1 returning id", [id])).toEqual(
        [],
      );
      expect(
        await tx.error("update library.prompt set owner_id = $2 where id = $1", [id, s.cal]),
      ).toMatch(/permission denied/);
      // Nor share it on.
      expect(await tx.error("select * from library.set_shares('prompt', $1, '[]')", [id])).toMatch(
        /FORBIDDEN/,
      );

      await tx.as(s.ben, s.acme);
      expect(await share(tx, "prompt", id, [])).toEqual([
        {
          principal_type: "group",
          principal_id: s.groups.litTeam,
          level: "edit",
          change: "removed",
        },
      ]);
      expect(await sees(tx, s.cal, s.acme, "prompt", id)).toBe(false);
    });
  });

  it("go workspace-wide only through library.manage, never to guests", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await prompt(tx, s, s.ben);
      await tx.as(s.ben, s.acme);
      const everyone = [{ principal_type: "workspace", principal_id: s.acme, level: "use" }];
      expect(
        await tx.error("select * from library.set_shares('prompt', $1, $2::jsonb)", [
          id,
          JSON.stringify(everyone),
        ]),
      ).toMatch(/SHARING_RESTRICTED/);
      expect(
        await tx.error("select * from library.set_shares('prompt', $1, $2::jsonb)", [
          id,
          JSON.stringify([{ principal_type: "user", principal_id: s.gia, level: "use" }]),
        ]),
      ).toMatch(/NOT_MEMBER/);
      expect(
        await tx.error("select * from library.set_shares('prompt', $1, $2::jsonb)", [
          id,
          JSON.stringify([{ principal_type: "user", principal_id: "not-a-uuid", level: "use" }]),
        ]),
      ).toMatch(/INVALID_GRANTS/);

      await tx.as(s.ana, s.acme);
      await share(tx, "prompt", id, everyone);
      expect(await sees(tx, s.cal, s.acme, "prompt", id)).toBe(true);
      expect(await sees(tx, s.gia, s.acme, "prompt", id)).toBe(false);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select label, level from library.shares('prompt', $1)", [id])).toEqual([
        { label: "Everyone", level: "use" },
      ]);
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select * from library.shares('prompt', $1)", [id])).toEqual([]);
    });
  });

  it("take their shares with them when deleted", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await prompt(tx, s, s.ben);
      await tx.as(s.ben, s.acme);
      await share(tx, "prompt", id, [
        { principal_type: "user", principal_id: s.cal, level: "use" },
      ]);
      expect(
        await tx.rows("delete from library.prompt where id = $1 returning id", [id]),
      ).toHaveLength(1);
      await tx.asOwner();
      expect(await tx.rows("select 1 from core.share_grant where object_id = $1", [id])).toEqual(
        [],
      );
    });
  });
});

describe("firm templates", () => {
  it("are uploaded only by library.manage", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          "insert into library.template (workspace_id, owner_id, name) values ($1, $2, 'x')",
          [s.acme, s.ben],
        ),
      ).toMatch(/row-level security/);
      const id = await template(tx, s);
      expect(await sees(tx, s.ben, s.acme, "template", id)).toBe(false);
      expect(await sees(tx, s.ben, s.acme, "template_version", id)).toBe(false);
    });
  });

  it("can be the workspace default, which every member who drafts may use", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await template(tx, s);
      const other = await template(tx, s);
      await tx.as(s.ben, s.acme);
      expect(await tx.error("select library.set_default_template($1, true)", [id])).toMatch(
        /FORBIDDEN/,
      );

      await tx.as(s.ana, s.acme);
      await tx.rows("select library.set_default_template($1, true)", [other]);
      await tx.rows("select library.set_default_template($1, true)", [id]);
      expect(await tx.rows("select id from library.template where is_default")).toEqual([{ id }]);

      expect(await sees(tx, s.ben, s.acme, "template", id)).toBe(true);
      expect(await sees(tx, s.ben, s.acme, "template", other)).toBe(false);
      expect(
        await tx.rows("select no from library.template_version where template_id = $1", [id]),
      ).toEqual([{ no: 1 }]);
      // Using is not editing: no new versions from Ben.
      expect(
        await tx.error(
          `insert into library.template_version (workspace_id, template_id, no, file_name, bytes, sha256, created_by)
           values ($1, $2, 2, 'x.docx', '\\x504b', $3, $4)`,
          [s.acme, id, SHA, s.ben],
        ),
      ).toMatch(/row-level security/);
      expect(await sees(tx, s.gia, s.acme, "template", id)).toBe(false);
      expect(await sees(tx, s.bob, s.beta, "template", id)).toBe(false);
    });
  });

  it("let an editor add a version but not delete the template", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await template(tx, s);
      await share(tx, "template", id, [
        { principal_type: "user", principal_id: s.cal, level: "edit" },
      ]);
      await tx.as(s.cal, s.acme);
      await tx.rows(
        `insert into library.template_version (workspace_id, template_id, no, file_name, bytes, sha256, created_by)
         values ($1, $2, 2, 'v2.docx', '\\x504b', $3, $4)`,
        [s.acme, id, SHA, s.cal],
      );
      expect(
        await tx.rows("delete from library.template where id = $1 returning id", [id]),
      ).toEqual([]);
      expect(
        await tx.error("update library.template_version set note = 'x' where template_id = $1", [
          id,
        ]),
      ).toMatch(/permission denied/);
    });
  });
});

describe("library guards", () => {
  it("keeps guests out even when a group they're in is shared", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await prompt(tx, s, s.ana);
      const tpl = await template(tx, s);
      await tx.as(s.ana, s.acme);
      // Gia, a guest, is in the party group.
      await share(tx, "prompt", id, [
        { principal_type: "group", principal_id: s.groups.partyP, level: "edit" },
      ]);
      await share(tx, "template", tpl, [
        { principal_type: "group", principal_id: s.groups.partyP, level: "use" },
      ]);
      expect(await sees(tx, s.gia, s.acme, "prompt", id)).toBe(false);
      expect(await sees(tx, s.gia, s.acme, "template", tpl)).toBe(false);
      expect(
        await tx.rows("select 1 from library.template_version where template_id = $1", [tpl]),
      ).toEqual([]);
      expect(
        await tx.rows("update library.prompt set name = 'x' where id = $1 returning id", [id]),
      ).toEqual([]);
    });
  });

  it("sets the default only through its function", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          "insert into library.template (workspace_id, owner_id, name, is_default) values ($1, $2, 'x', true)",
          [s.acme, s.ana],
        ),
      ).toMatch(/permission denied/);
    });
  });
});
