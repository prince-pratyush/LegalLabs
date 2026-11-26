import { randomBytes, randomUUID } from "node:crypto";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { type Seeded, seedMember, testPool } from "../test-db.js";
import { createRetentionJob } from "../vaults/retention.js";
import { createRetentionSweepJob } from "./job.js";
import { createRetention } from "./service.js";

/*
 * SEC-029: the strictest applicable scope wins. Effective hours are the shortest non-null of the
 * workspace and (the matter if it has a policy, otherwise the vault). The clock is advanced by
 * moving every timestamp of one workspace into the past.
 */

const pool = testPool();
afterAll(() => pool.end());

const store = createMemoryStore();
const sweep = createRetentionSweepJob(pool, { store });
const vaultJob = createRetentionJob(pool, { store });
const retention = createRetention(pool, { store });

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];
const one = async (sql: string, params: unknown[]) =>
  (await q<{ id: string }>(sql, params))[0]?.id ?? "";

const principal = (m: Seeded) => ({ sessionId: "", userId: m.userId, workspaceId: m.workspaceId });

async function policy(m: Seeded, scope: string, scopeId: string, hours: number | null) {
  await q(
    "insert into retention.policy (workspace_id, scope, scope_id, hours) values ($1, $2, $3, $4)",
    [m.workspaceId, scope, scopeId, hours],
  );
}

const matter = (m: Seeded) =>
  one(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
     values ($1, 'C1', 'Client', $2, 'M', 'open') returning id`,
    [m.workspaceId, `M-${randomUUID().slice(0, 8)}`],
  );

const vault = (m: Seeded, opts: { matterId?: string; legacy?: number } = {}) =>
  one(
    `insert into content.vault (workspace_id, owner_id, name, matter_id, retention_hours)
     values ($1, $2, 'V', $3, $4) returning id`,
    [m.workspaceId, m.userId, opts.matterId ?? null, opts.legacy ?? null],
  );

async function doc(m: Seeded, vaultId: string) {
  const id = await one(
    `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id, matter_id)
     select $1, $2, 'd.txt', 'text/plain', 10, v.id, v.matter_id from content.vault v where v.id = $3
     returning id`,
    [m.workspaceId, m.userId, vaultId],
  );
  await q(
    `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
     values ($1, $2, $3, 1, $4)`,
    [m.workspaceId, id, randomBytes(32), m.userId],
  );
  return id;
}

const thread = (m: Seeded, matterId: string) =>
  one(
    `insert into work.thread (workspace_id, owner_id, title, matter_id)
     values ($1, $2, 'T', $3) returning id`,
    [m.workspaceId, m.userId, matterId],
  );

const table = (m: Seeded, matterId: string) =>
  one(
    `insert into work.review_table (workspace_id, owner_id, name, source_kind, matter_id)
     values ($1, $2, 'Table', 'uploads', $3) returning id`,
    [m.workspaceId, m.userId, matterId],
  );

/** Moves one workspace `hours` into the past, which is the same as that much time going by. */
async function advance(m: Seeded, hours: number) {
  for (const sql of [
    `update content.document set created_at = created_at - $2::interval,
       restored_at = restored_at - $2::interval where workspace_id = $1`,
    "update content.document_version set created_at = created_at - $2::interval where workspace_id = $1",
    "update work.thread set last_activity_at = last_activity_at - $2::interval where workspace_id = $1",
    "update work.review_table set updated_at = updated_at - $2::interval where workspace_id = $1",
    "update retention.recycle_bin set restorable_until = restorable_until - $2::interval where workspace_id = $1",
  ]) {
    await q(sql, [m.workspaceId, `${hours} hours`]);
  }
}

const expired = async (m: Seeded) =>
  new Map(
    (
      await q<{ object_id: string; hours: number; policy_scope: string }>(
        "select object_id, hours, policy_scope from retention.expired_objects($1)",
        [m.workspaceId],
      )
    ).map((r) => [r.object_id, r]),
  );

/** [name, hours after which it is eligible, scope that binds]; null is never. */
type Case = [string, number | null, "workspace" | "vault" | "matter" | null];

/** Steps the clock to just before and just after every expected time, and far past them. */
async function check(m: Seeded, ids: Record<string, string>, cases: Case[]) {
  let clock = 0;
  const stops = [...new Set(cases.flatMap(([, h]) => (h === null ? [] : [h - 1, h + 1])))];
  for (const stop of [...stops, 5000].sort((a, b) => a - b)) {
    await advance(m, stop - clock);
    clock = stop;
    const now = await expired(m);
    for (const [name, after, scope] of cases) {
      const row = now.get(ids[name] ?? "");
      expect(row !== undefined, `${name} at ${stop} h`).toBe(after !== null && stop > after);
      if (row) expect([row.hours, row.policy_scope], name).toEqual([after, scope]);
    }
  }
}

describe("retention: the strictest applicable scope wins (SEC-029)", () => {
  it("never lets a vault or matter outlive the workspace limit", async () => {
    const m = await seedMember(pool);
    await policy(m, "workspace", m.workspaceId, 100);
    const ids: Record<string, string> = {};

    ids.workspaceOnly = await doc(m, await vault(m));
    for (const [name, hours] of [
      ["vaultLonger", 200],
      ["vaultShorter", 20],
      ["vaultUnlimited", null],
    ] as const) {
      const v = await vault(m);
      await policy(m, "vault", v, hours);
      ids[name] = await doc(m, v);
    }
    ids.legacyLonger = await doc(m, await vault(m, { legacy: 200 }));

    // A matter policy replaces the vault's, in either direction.
    for (const [name, matterHours, vaultHours] of [
      ["matterLooserThanVault", 50, 20],
      ["matterStricterThanVault", 20, 50],
      ["matterPastWorkspace", 200, 20],
      ["matterUnlimited", null, 20],
    ] as const) {
      const mt = await matter(m);
      await policy(m, "matter", mt, matterHours);
      const v = await vault(m, { matterId: mt });
      await policy(m, "vault", v, vaultHours);
      ids[name] = await doc(m, v);
    }

    // A matter with no policy leaves the vault's in force.
    const plain = await vault(m, { matterId: await matter(m) });
    await policy(m, "vault", plain, 20);
    ids.matterWithoutPolicy = await doc(m, plain);

    for (const [name, hours] of [
      ["Longer", 200],
      ["Unlimited", null],
      ["Shorter", 20],
    ] as const) {
      const mt = await matter(m);
      await policy(m, "matter", mt, hours);
      ids[`thread${name}`] = await thread(m, mt);
      ids[`table${name}`] = await table(m, mt);
    }

    await check(m, ids, [
      ["workspaceOnly", 100, "workspace"],
      ["vaultLonger", 100, "workspace"],
      ["vaultShorter", 20, "vault"],
      ["vaultUnlimited", 100, "workspace"],
      ["legacyLonger", 100, "workspace"],
      ["matterLooserThanVault", 50, "matter"],
      ["matterStricterThanVault", 20, "matter"],
      ["matterPastWorkspace", 100, "workspace"],
      ["matterUnlimited", 100, "workspace"],
      ["matterWithoutPolicy", 20, "vault"],
      ["threadLonger", 100, "workspace"],
      ["tableLonger", 100, "workspace"],
      ["threadUnlimited", 100, "workspace"],
      ["tableUnlimited", 100, "workspace"],
      ["threadShorter", 20, "matter"],
      ["tableShorter", 20, "matter"],
    ]);
  });

  it("with an unlimited workspace, the matter if set, else the vault, decides", async () => {
    const m = await seedMember(pool);
    await policy(m, "workspace", m.workspaceId, null);
    const v = await vault(m);
    await policy(m, "vault", v, 20);
    const mt = await matter(m);
    await policy(m, "matter", mt, null);
    const kept = await vault(m, { matterId: mt });
    await policy(m, "vault", kept, 20);
    await check(m, { vaultOnly: await doc(m, v), matterKeeps: await doc(m, kept) }, [
      ["vaultOnly", 20, "vault"],
      ["matterKeeps", null, null],
    ]);
  });

  it("keeps held objects, and bins what the workspace limit takes for 30 restorable days", async () => {
    const m = await seedMember(pool);
    await policy(m, "workspace", m.workspaceId, 100);
    const v = await vault(m);
    await policy(m, "vault", v, null);
    const free = await doc(m, v);
    const held = await doc(m, v);
    await q(
      `insert into retention.hold (workspace_id, object_type, object_id, reason, set_by)
       values ($1, 'document', $2, 'Case', $3)`,
      [m.workspaceId, held, m.userId],
    );
    await advance(m, 101);

    const estimate = await retention.estimate(principal(m), "vault", v, null);
    expect(estimate.ok && [estimate.value.total, estimate.value.held]).toEqual([1, 1]);
    const listed = await retention.policies(principal(m));
    expect(listed.ok && listed.value.vaults[0]?.effectiveHours).toBe(100);

    const state = async () =>
      Object.fromEntries(
        (
          await q<{ id: string; deleted_reason: string | null }>(
            "select id, deleted_reason from content.document where workspace_id = $1",
            [m.workspaceId],
          )
        ).map((r) => [r.id, r.deleted_reason]),
      );
    await sweep.runOnce();
    await vaultJob.runOnce();
    // 'user' is the bin that waits 30 days; 'retention' would be removed at the next pass.
    expect(await state()).toEqual({ [free]: "user", [held]: null });

    await advance(m, 29 * 24);
    await sweep.runOnce();
    await vaultJob.runOnce();
    expect(await state()).toEqual({ [free]: "user", [held]: null });
    await advance(m, 2 * 24);
    await sweep.runOnce();
    expect(await state()).toEqual({ [held]: null });
  });

  it("stops the vault setting where a matter or a vault policy replaces it", async () => {
    const m = await seedMember(pool);
    const mt = await matter(m);
    await policy(m, "matter", mt, 200);
    const inMatter = await doc(m, await vault(m, { matterId: mt, legacy: 20 }));
    const replaced = await vault(m, { legacy: 20 });
    await policy(m, "vault", replaced, null);
    const kept = await doc(m, replaced);
    await doc(m, await vault(m, { legacy: 20 }));
    await advance(m, 21);
    await vaultJob.runOnce();
    const left = await q<{ id: string }>(
      "select id from content.document where workspace_id = $1 and deleted_at is null",
      [m.workspaceId],
    );
    expect(left.map((r) => r.id).sort()).toEqual([inMatter, kept].sort());
  });

  it("does not delete a restored file at once under the vault setting", async () => {
    const m = await seedMember(pool);
    await policy(m, "workspace", m.workspaceId, 24);
    const id = await doc(m, await vault(m, { legacy: 100 }));
    await advance(m, 25);
    await sweep.runOnce();
    await advance(m, 100);
    const [item] = await q<{ id: string }>(
      "select id from retention.recycle_bin where workspace_id = $1",
      [m.workspaceId],
    );
    const restored = await retention.restore(
      principal(m),
      { ip: null, userAgent: null },
      item?.id ?? "",
    );
    expect(restored.ok).toBe(true);
    await vaultJob.runOnce();
    expect(await q("select deleted_at from content.document where id = $1", [id])).toEqual([
      { deleted_at: null },
    ]);
  });
});
