import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

/** ben may build, and holds Run on ana's agent, which carries an upload. */
async function shared(tx: Tx) {
  const s = await seed(tx);
  await tx.asOwner();
  await tx.rows(`update core."user" set extra_permissions = $2 where id = $1`, [
    s.ben,
    ["agents.use", "agents.build"],
  ]);
  const agent = s.agents.acme;
  await tx.rows(
    `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                   principal_id, level, granted_by)
     values ($1, 'agent', $2, 'user', $3, 'run', $4)`,
    [s.acme, agent.agentId, s.ben, s.ana],
  );
  return { s, agent };
}

describe("agent uploads after a Run grant (F-40)", () => {
  it("can't be linked into the runner's own agent", async () => {
    await withTx(async (tx) => {
      const { s } = await shared(tx);
      await tx.as(s.ben, s.acme);
      const mine = await tx.one<{ id: string }>(
        `insert into work.agent (workspace_id, owner_id, title) values ($1, $2, 'Mine') returning id`,
        [s.acme, s.ben],
      );
      expect(
        await tx.error(
          "insert into work.agent_document (workspace_id, agent_id, document_id) values ($1, $2, $3)",
          [s.acme, mine.id, s.documents.acme.documentId],
        ),
      ).toMatch(/row-level security/);
    });
  });
});

describe("agent shares and matter walls (F-41)", () => {
  it("give a walled person nothing from a direct grant", async () => {
    await withTx(async (tx) => {
      const { s, agent } = await shared(tx);
      const doc = s.documents.acme.documentId;
      const m2 = s.matters.m2;
      await tx.asOwner();
      await tx.rows("update core.matter set require_walls_for_sharing = true where id = $1", [m2]);
      await tx.rows("update content.document set matter_id = $2 where id = $1", [doc, m2]);
      const v = await tx.one<{ id: string }>(
        `insert into work.agent_version (workspace_id, agent_id, no, instructions, attachments,
                                         details, created_by)
         values ($1, $2, 2, 'Advise.', $3, '{}', $4) returning id`,
        [
          s.acme,
          agent.agentId,
          JSON.stringify([{ label: "a", kind: "upload", ref: doc, name: "a" }]),
          s.ana,
        ],
      );
      await tx.rows("update work.agent set live_version_id = $2 where id = $1", [
        agent.agentId,
        v.id,
      ]);
      const level = async () =>
        (await tx.one<{ l: string | null }>("select work.agent_level($1) l", [agent.agentId])).l;
      await tx.as(s.ben, s.acme);
      expect(await level()).toBe("run");
      await tx.asOwner();
      await tx.rows(
        `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
         values ($1, $2, 'user', $3, 'deny')`,
        [s.acme, m2, s.ben],
      );
      await tx.as(s.ben, s.acme);
      expect(await level()).toBeNull();
      await tx.as(s.ana, s.acme);
      expect(await level()).toBe("full");
    });
  });
});
