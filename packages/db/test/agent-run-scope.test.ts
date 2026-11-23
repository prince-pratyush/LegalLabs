import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

/*
 * Pen-test P-04 (SEC-024): a run carries the Space and matter it works in, and the rest of the
 * system trusts those columns (who may control the run, which model rules apply). A person must
 * not be able to start a run inside a Space they cannot see or a matter they are walled from.
 */

async function setup(tx: Tx) {
  const s = await seed(tx);
  await tx.asOwner();
  // Ben and Cal may run agents. Ben is walled from M1 and sits in the seeded Space; Cal is in
  // neither the Space nor any wall.
  await tx.rows(
    `update core."user" set extra_permissions = array['agents.use'] where id = any($1)`,
    [[s.ben, s.cal]],
  );
  const thread = async (owner: string) => {
    const { id } = await tx.one<{ id: string }>(
      `insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'T') returning id`,
      [s.acme, owner],
    );
    const q = await tx.one<{ id: string }>(
      `insert into work.message (workspace_id, thread_id, role, content)
       values ($1, $2, 'user', 'go') returning id`,
      [s.acme, id],
    );
    return { id, question: q.id };
  };
  return { s, ana: await thread(s.ana), ben: await thread(s.ben), cal: await thread(s.cal) };
}

const run = (
  tx: Tx,
  ws: string,
  owner: string,
  t: { id: string; question: string },
  extra: { space?: string | null; matter?: string | null },
) =>
  tx.error(
    `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id, subject_id,
                           space_id, matter_id)
     values ($1, $2, $3, 'agent', 'planned', $4, gen_random_uuid(), $5, $6)`,
    [ws, t.id, owner, t.question, extra.space ?? null, extra.matter ?? null],
  );

describe("P-04 a run cannot claim a Space or matter its owner has no access to", () => {
  it("refuses a Space the owner cannot see", async () => {
    await withTx(async (tx) => {
      const { s, cal } = await setup(tx);
      await tx.as(s.cal, s.acme);
      expect(await run(tx, s.acme, s.cal, cal, { space: s.spaces.acme.spaceId })).toMatch(
        /row-level security/,
      );
    });
  });

  it("refuses a Space of another workspace", async () => {
    await withTx(async (tx) => {
      const { s, ben } = await setup(tx);
      await tx.as(s.ben, s.acme);
      expect(await run(tx, s.acme, s.ben, ben, { space: s.spaces.beta.spaceId })).toMatch(
        /row-level security/,
      );
    });
  });

  it("refuses a matter the owner is walled from", async () => {
    await withTx(async (tx) => {
      const { s, ben } = await setup(tx);
      await tx.as(s.ben, s.acme);
      // Ben has a deny row on M1.
      expect(await run(tx, s.acme, s.ben, ben, { matter: s.matters.m1 })).toMatch(
        /row-level security/,
      );
    });
  });

  it("still accepts a Space the owner created, a matter they can open, and neither", async () => {
    await withTx(async (tx) => {
      const { s, ana, ben } = await setup(tx);
      // Ana created the Space and sits on M1's allow-list.
      await tx.as(s.ana, s.acme);
      expect(await run(tx, s.acme, s.ana, ana, { space: s.spaces.acme.spaceId })).toBeUndefined();
      expect(await run(tx, s.acme, s.ana, ana, { matter: s.matters.m1 })).toBeUndefined();
      await tx.as(s.ben, s.acme);
      expect(await run(tx, s.acme, s.ben, ben, {})).toBeUndefined();
    });
  });
});
