import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

// ana (admin) owns the seeded agent; ben and cal are members whose permissions each test sets.
async function setup(tx: Tx, perms: { ben?: string[]; cal?: string[] } = {}) {
  const s = await seed(tx);
  await tx.asOwner();
  for (const [who, list] of [
    [s.ben, perms.ben ?? ["agents.use"]],
    [s.cal, perms.cal ?? ["agents.use"]],
  ] as const) {
    await tx.rows(`update core."user" set extra_permissions = $2 where id = $1`, [who, list]);
  }
  return { s, agent: s.agents.acme };
}

const grant = (
  tx: Tx,
  s: { acme: string; ana: string },
  agent: string,
  who: string,
  level: string,
) =>
  tx.rows(
    `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                   principal_id, level, granted_by)
     values ($1, 'agent', $2, 'user', $3, $4, $5)`,
    [s.acme, agent, who, level, s.ana],
  );

describe("agent access", () => {
  it("ranks run below view", async () => {
    await withTx(async (tx) => {
      const rank = async (l: string) =>
        (await tx.one<{ r: number }>("select core.level_rank($1) r", [l])).r;
      expect([
        await rank("run"),
        await rank("view"),
        await rank("edit"),
        await rank("full"),
      ]).toEqual([1, 2, 3, 4]);
    });
  });

  it("hides an agent from members it isn't shared with", async () => {
    await withTx(async (tx) => {
      const { s } = await setup(tx);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from work.agent")).toEqual([]);
    });
  });

  it("lets a Run grant execute the live version but not read it", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await grant(tx, s, agent.agentId, s.ben, "run");
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select title from work.agent")).toEqual([{ title: "NDA first pass" }]);
      expect(await tx.rows("select id from work.agent_version")).toEqual([]);
      const live = await tx.rows("select instructions from work.agent_version_for_run($1, $2)", [
        agent.agentId,
        agent.versionId,
      ]);
      expect(live).toEqual([{ instructions: "Review the NDA." }]);
    });
  });

  it("lets a View grant read versions, but not save one", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx, { ben: ["agents.use", "agents.build"] });
      await grant(tx, s, agent.agentId, s.ben, "view");
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select no from work.agent_version")).toEqual([{ no: 1 }]);
      const err = await tx.error(
        `insert into work.agent_version (workspace_id, agent_id, no, instructions, created_by)
         values ($1, $2, 2, 'x', $3)`,
        [s.acme, agent.agentId, s.ben],
      );
      expect(err).toMatch(/row-level security/);
    });
  });

  it("lets an Edit grant save a version only with agents.build", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx, {
        ben: ["agents.use"],
        cal: ["agents.use", "agents.build"],
      });
      await grant(tx, s, agent.agentId, s.ben, "edit");
      await grant(tx, s, agent.agentId, s.cal, "edit");
      const save = `insert into work.agent_version (workspace_id, agent_id, no, instructions, created_by)
                    values ($1, $2, 2, 'x', $3)`;
      await tx.as(s.ben, s.acme);
      expect(await tx.error(save, [s.acme, agent.agentId, s.ben])).toMatch(/row-level security/);
      await tx.as(s.cal, s.acme);
      expect(await tx.error(save, [s.acme, agent.agentId, s.cal])).toBeUndefined();
    });
  });

  it("stops a share working when the grantee loses agents.use", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await grant(tx, s, agent.agentId, s.ben, "run");
      await tx.asOwner();
      await tx.rows(`update core."user" set extra_permissions = '{}' where id = $1`, [s.ben]);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from work.agent")).toEqual([]);
    });
  });

  it("only lets builders create agents", async () => {
    await withTx(async (tx) => {
      const { s } = await setup(tx, { ben: ["agents.use"], cal: ["agents.use", "agents.build"] });
      const make = (who: string) =>
        tx.error(`insert into work.agent (workspace_id, owner_id, title) values ($1, $2, 'Mine')`, [
          s.acme,
          who,
        ]);
      await tx.as(s.ben, s.acme);
      expect(await make(s.ben)).toMatch(/row-level security/);
      await tx.as(s.cal, s.acme);
      expect(await make(s.cal)).toBeUndefined();
    });
  });

  it("keeps another workspace's agents out of sight, even from its admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.bob, s.beta);
      const titles = await tx.rows("select id from work.agent");
      expect(titles).toEqual([{ id: s.agents.beta.agentId }]);
    });
  });
});

describe("agent uploads", () => {
  it("are readable by those who may run the agent, and only them", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      const doc = s.documents.acme.documentId;
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from content.document where id = $1", [doc])).toEqual([]);
      await tx.asOwner();
      await grant(tx, s, agent.agentId, s.ben, "run");
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from content.document where id = $1", [doc])).toHaveLength(1);
      expect(
        await tx.rows("select 1 from content.page where version_id = $1", [
          s.documents.acme.versionId,
        ]),
      ).not.toEqual([]);
    });
  });
});

describe("schedules", () => {
  const insert = `insert into work.agent_schedule (workspace_id, agent_id, user_id, rule, params,
                    time_local, tz) values ($1, $2, $3, 'weekly', '{"weekdays":[1]}', '08:00', 'UTC')`;

  it("are one per agent per user, and need a live version", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await grant(tx, s, agent.agentId, s.ben, "run");
      await tx.as(s.ben, s.acme);
      expect(await tx.error(insert, [s.acme, agent.agentId, s.ben])).toBeUndefined();
      expect(await tx.error(insert, [s.acme, agent.agentId, s.ben])).toMatch(/duplicate key/);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        `update work.agent set live_version_id = null, draft_version_id = $2 where id = $1`,
        [agent.agentId, agent.versionId],
      );
      await tx.as(s.cal, s.acme);
      await tx.asOwner();
      await grant(tx, s, agent.agentId, s.cal, "run");
      await tx.as(s.cal, s.acme);
      expect(await tx.error(insert, [s.acme, agent.agentId, s.cal])).toMatch(/row-level security/);
    });
  });

  it("are paused, with a reason, when the agent is deleted", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await grant(tx, s, agent.agentId, s.ben, "run");
      await tx.as(s.ben, s.acme);
      await tx.rows(insert, [s.acme, agent.agentId, s.ben]);
      await tx.as(s.ana, s.acme);
      await tx.rows(`update work.agent set deleted_at = now(), deleted_by = $2 where id = $1`, [
        agent.agentId,
        s.ana,
      ]);
      await tx.asOwner();
      const rows = await tx.rows(
        "select status, paused_reason from work.agent_schedule where agent_id = $1 order by user_id",
        [agent.agentId],
      );
      expect(rows.every((r) => r.status === "paused" && r.paused_reason === "agent_deleted")).toBe(
        true,
      );
      expect(rows.length).toBe(2);
    });
  });
});

describe("share requests", () => {
  const request = (tx: Tx, ws: string, agent: string, by: string) =>
    tx.one<{ id: string }>(
      `insert into work.share_request (workspace_id, resource_type, resource_id, principal_type,
                                       principal_id, level, approver, requested_by)
       values ($1, 'agent', $2, 'workspace', $1, 'view', 'agents_admin', $3) returning id`,
      [ws, agent, by],
    );

  it("are written only by someone with Full access to the agent", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await tx.asOwner();
      await tx.rows("delete from work.share_request");
      await grant(tx, s, agent.agentId, s.ben, "edit");
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into work.share_request (workspace_id, resource_type, resource_id, principal_type,
           principal_id, level, approver, requested_by)
         values ($1, 'agent', $2, 'workspace', $1, 'run', 'agents_admin', $3)`,
          [s.acme, agent.agentId, s.ben],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("are decided only by an agents.admin, and acceptance writes the grant", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await tx.asOwner();
      await tx.rows("delete from work.share_request");
      await tx.as(s.ana, s.acme);
      const req = await request(tx, s.acme, agent.agentId, s.ana);

      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from work.share_request")).toEqual([]);
      expect(
        (
          await tx.one<{ r: string }>("select work.decide_share_request($1, true, null) r", [
            req.id,
          ])
        ).r,
      ).toBe("FORBIDDEN");

      await tx.as(s.ana, s.acme);
      expect(
        (
          await tx.one<{ r: string }>("select work.decide_share_request($1, true, null) r", [
            req.id,
          ])
        ).r,
      ).toBe("OK");
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select title from work.agent")).toEqual([{ title: "NDA first pass" }]);
    });
  });

  it("are never decided by a workspace admin when a Space's admins must", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await tx.asOwner();
      await tx.rows("delete from work.share_request");
      const { id } = await tx.one<{ id: string }>(
        `insert into work.share_request (workspace_id, resource_type, resource_id, principal_type,
           principal_id, level, approver, requested_by)
         values ($1, 'agent', $2, 'group', $3, 'run', 'space_admin', $4) returning id`,
        [s.acme, agent.agentId, s.groups.everyone, s.ana],
      );
      await tx.as(s.ana, s.acme);
      expect(
        (await tx.one<{ r: string }>("select work.decide_share_request($1, true, null) r", [id])).r,
      ).toBe("FORBIDDEN");
    });
  });

  it("allow one pending request per target", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await setup(tx);
      await tx.asOwner();
      await tx.rows("delete from work.share_request");
      await tx.as(s.ana, s.acme);
      await request(tx, s.acme, agent.agentId, s.ana);
      expect(
        await tx.error(
          `insert into work.share_request (workspace_id, resource_type, resource_id, principal_type,
           principal_id, level, approver, requested_by)
         values ($1, 'agent', $2, 'workspace', $1, 'view', 'agents_admin', $3)`,
          [s.acme, agent.agentId, s.ana],
        ),
      ).toMatch(/duplicate key/);
    });
  });
});
