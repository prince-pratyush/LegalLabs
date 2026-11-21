import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

// Ben and Cal hold no Space permissions by default, so give them the ordinary ones.
async function withSpacePermissions(tx: Tx, s: Seed) {
  await tx.asOwner();
  await tx.rows(
    `update core."user" set extra_permissions = '{spaces.create,spaces.invite}' where id = any($1)`,
    [[s.ben, s.cal]],
  );
}

async function createSpace(tx: Tx, s: Seed, owner: string, name: string, matter: string | null) {
  // No `returning`: the creator is only a member once the insert has finished.
  const { id } = await tx.one<{ id: string }>("select core.uuid7() as id");
  await tx.as(owner, s.acme);
  await tx.rows(
    `insert into work.space (id, workspace_id, name, matter_id, created_by)
     values ($1, $2, $3, $4, $5)`,
    [id, s.acme, name, matter, owner],
  );
  await tx.asOwner();
  return id;
}

async function addMember(tx: Tx, s: Seed, spaceId: string, type: string, id: string, role: string) {
  await tx.asOwner();
  await tx.rows(
    `insert into work.space_member (workspace_id, space_id, principal_type, principal_id, role)
     values ($1, $2, $3, $4, $5)`,
    [s.acme, spaceId, type, id, role],
  );
}

async function visible(tx: Tx, s: Seed, user: string, table: string) {
  await tx.as(user, s.acme);
  const rows = await tx.rows(`select id from ${table}`);
  await tx.asOwner();
  return rows.length;
}

describe("spaces", () => {
  it("makes the creator its first admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Acme deal", null);
      await tx.as(s.ana, s.acme);
      const role = await tx.one("select work.space_role($1) as role", [space]);
      expect(role.role).toBe("admin");
    });
  });

  it("needs spaces.create to make one", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const err = await tx.error(
        "insert into work.space (workspace_id, name, created_by) values ($1, 'No', $2)",
        [s.acme, s.ben],
      );
      expect(err).toMatch(/row-level security/);
    });
  });

  it("hides a Space from people who are not in it, and shows it to a group member", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Private room", null);
      expect(await visible(tx, s, s.ben, "work.space")).toBe(0);
      await addMember(tx, s, space, "group", s.groups.corpTeam, "collaborator");
      expect(await visible(tx, s, s.ben, "work.space")).toBe(1);
      expect(await visible(tx, s, s.cal, "work.space")).toBe(0);
    });
  });

  it("lets a matter have one live Space only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await createSpace(tx, s, s.ana, "First", s.matters.m2);
      await tx.as(s.ana, s.acme);
      const err = await tx.error(
        "insert into work.space (workspace_id, name, matter_id, created_by) values ($1, 'Second', $2, $3)",
        [s.acme, s.matters.m2, s.ana],
      );
      expect(err).toMatch(/space_matter_idx/);
    });
  });

  it("cannot be made on a matter the creator is walled from", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await withSpacePermissions(tx, s);
      await tx.as(s.cal, s.acme);
      const err = await tx.error(
        "insert into work.space (workspace_id, name, matter_id, created_by) values ($1, 'Walled', $2, $3)",
        [s.acme, s.matters.m1, s.cal],
      );
      expect(err).toMatch(/row-level security/);
    });
  });

  it("goes dead to a member who is walled from its matter, and is hidden in the directory", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Lit matter", s.matters.m2);
      await addMember(tx, s, space, "user", s.cal, "collaborator");
      // Cal is denied on M2, so membership gives him nothing.
      expect(await visible(tx, s, s.cal, "work.space")).toBe(0);
      await tx.as(s.cal, s.acme);
      const listed = await tx.rows<{ id: string }>("select id from work.space_directory()");
      expect(listed.map((r) => r.id)).not.toContain(space);
    });
  });

  it("shows a Space locked to someone who can reach its matter but is not in it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Open room", s.matters.m2);
      await tx.as(s.ben, s.acme);
      const rows = await tx.rows("select id, locked from work.space_directory()");
      expect(rows.filter((r) => r.id === space)).toEqual([{ id: space, locked: true }]);
      // And may ask to join.
      expect(
        await tx.error(
          "insert into work.space_access_request (workspace_id, space_id, user_id) values ($1, $2, $3)",
          [s.acme, space, s.ben],
        ),
      ).toBeUndefined();
    });
  });

  it("refuses an access request for a Space the requester is walled from", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Closed room", s.matters.m1);
      await tx.as(s.cal, s.acme);
      expect(
        await tx.error(
          "insert into work.space_access_request (workspace_id, space_id, user_id) values ($1, $2, $3)",
          [s.acme, space, s.cal],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("adds a shared resource's access to a member's own, and takes it away when removed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Shared", null);
      await addMember(tx, s, space, "user", s.ben, "collaborator");
      const vault = await tx.one<{ id: string }>("select core.uuid7() as id");
      const has = async (user: string, level: string) => {
        await tx.as(user, s.acme);
        const row = await tx.one("select core.has_access('vault', $1, $2) as ok", [vault.id, level]);
        await tx.asOwner();
        return row.ok;
      };
      expect(await has(s.ben, "view")).toBe(false);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id, access, granted_by)
         values ($1, $2, 'vault', $3, 'edit', $4)`,
        [s.acme, space, vault.id, s.ana],
      );
      await tx.asOwner();
      expect(await has(s.ben, "edit")).toBe(true);
      expect(await has(s.ben, "full")).toBe(false);
      // Not a member, so not reached.
      expect(await has(s.cal, "view")).toBe(false);
      await tx.as(s.ana, s.acme);
      await tx.rows("delete from work.space_resource where space_id = $1", [space]);
      await tx.asOwner();
      expect(await has(s.ben, "view")).toBe(false);
    });
  });

  it("does not let a walled member reach a resource through the Space", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Walled share", s.matters.m2);
      await addMember(tx, s, space, "user", s.cal, "collaborator");
      const vault = await tx.one<{ id: string }>("select core.uuid7() as id");
      await tx.rows(
        `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id, access, granted_by)
         values ($1, $2, 'vault', $3, 'view', $4)`,
        [s.acme, space, vault.id, s.ana],
      );
      await tx.as(s.cal, s.acme);
      expect((await tx.one("select core.has_access('vault', $1, 'view') as ok", [vault.id])).ok).toBe(
        false,
      );
    });
  });

  it("keeps the kind fixed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const space = await createSpace(tx, s, s.ana, "Fixed", null);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update work.space set kind = 'external' where id = $1", [space])).toMatch(
        /KIND_IMMUTABLE/,
      );
    });
  });
});

describe("phases and gates", () => {
  async function room(tx: Tx, s: Seed) {
    const space = await createSpace(tx, s, s.ana, "Deal", null);
    await addMember(tx, s, space, "user", s.ben, "collaborator");
    await tx.as(s.ana, s.acme);
    const phase = async (ordinal: number) =>
      (
        await tx.one<{ id: string }>(
          "insert into work.phase (workspace_id, space_id, ordinal, name) values ($1, $2, $3, 'P') returning id",
          [s.acme, space, ordinal],
        )
      ).id;
    const one = await phase(1);
    const two = await phase(2);
    const task = async (phaseId: string, gate: boolean) =>
      (
        await tx.one<{ id: string }>(
          `insert into work.task (workspace_id, space_id, phase_id, name, gate, created_by)
           values ($1, $2, $3, 'T', $4, $5) returning id`,
          [s.acme, space, phaseId, gate, s.ana],
        )
      ).id;
    const gate = await task(one, true);
    const next = await task(two, false);
    return { space, gate, next };
  }

  it("locks the next phase until the gate is approved", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { gate, next } = await room(tx, s);
      await tx.as(s.ben, s.acme);
      expect(await tx.error("update work.task set status = 'in_progress' where id = $1", [next])).toMatch(
        /PHASE_LOCKED/,
      );
      // Ben cannot finish a gate himself, nor approve it.
      expect(await tx.error("update work.task set status = 'done' where id = $1", [gate])).toMatch(
        /GATE_NEEDS_APPROVAL/,
      );
      expect(
        await tx.error("update work.task set approved_at = now(), approved_by = $2 where id = $1", [
          gate,
          s.ben,
        ]),
      ).toMatch(/permission|FORBIDDEN/);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          "update work.task set status = 'done', approved_by = $2, approved_at = now() where id = $1",
          [gate, s.ana],
        ),
      ).toBeUndefined();
      await tx.as(s.ben, s.acme);
      expect(await tx.error("update work.task set status = 'in_progress' where id = $1", [next])).toBeUndefined();
    });
  });

  it("lets a cancelled gate stop blocking the next phase", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { gate, next } = await room(tx, s);
      await tx.as(s.ana, s.acme);
      await tx.rows("update work.task set status = 'cancelled' where id = $1", [gate]);
      expect(await tx.error("update work.task set status = 'in_progress' where id = $1", [next])).toBeUndefined();
    });
  });

  it("stops a collaborator from creating a gate or reopening an approved task", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { space, gate } = await room(tx, s);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        "update work.task set status = 'done', approved_by = $2, approved_at = now() where id = $1",
        [gate, s.ana],
      );
      await tx.as(s.ben, s.acme);
      expect(await tx.error("update work.task set status = 'todo' where id = $1", [gate])).toMatch(
        /permission|FORBIDDEN/,
      );
      expect(
        await tx.error(
          "insert into work.task (workspace_id, space_id, name, gate, created_by) values ($1, $2, 'G', true, $3)",
          [s.acme, space, s.ben],
        ),
      ).toMatch(/permission|FORBIDDEN/);
    });
  });

  it("hides tasks from people outside the Space", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await room(tx, s);
      expect(await visible(tx, s, s.cal, "work.task")).toBe(0);
      expect(await visible(tx, s, s.ben, "work.task")).toBe(2);
    });
  });
});
