import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

const TABLES = [
  "horizon_scan",
  "horizon_cursor",
  "horizon_item",
  "horizon_item_state",
  "horizon_spend",
];

const count = async (tx: Tx, table: string) =>
  Number((await tx.one<{ n: string }>(`select count(*) n from apps.${table}`)).n);

const scan = (tx: Tx, s: Seed, owner: string, from = "current_date") =>
  tx.error(
    `insert into apps.horizon_scan (workspace_id, owner_id, name, purpose, sources, from_date)
     values ($1, $2, 'n', 'p', array['fr'], ${from})`,
    [s.acme, owner],
  );

describe("horizon scans in the database", () => {
  it("shows a scan and all under it to its owner alone, an admin included", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      for (const table of TABLES) expect([table, await count(tx, table)]).toEqual([table, 1]);
      await tx.asOwner();
      await tx.rows(
        "update core.role set permissions = '{*}' where workspace_id = $1 and name = 'User'",
        [s.acme],
      );
      await tx.as(s.ben, s.acme);
      for (const table of TABLES) expect([table, await count(tx, table)]).toEqual([table, 0]);
      const { scanId } = s.horizons.acme;
      await tx.rows("update apps.horizon_scan set purpose = 'mine now' where id = $1", [scanId]);
      await tx.rows("delete from apps.horizon_scan where id = $1", [scanId]);
      await tx.asOwner();
      expect(
        (await tx.one("select purpose from apps.horizon_scan where id = $1", [scanId])).purpose,
      ).toBe("Rules about widgets");
    });
  });

  it("needs the permission to make one, and a start no more than 28 days back", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await scan(tx, s, s.ben)).toMatch(/row-level security/);
      await tx.as(s.ana, s.acme);
      expect(await scan(tx, s, s.ben)).toMatch(/row-level security/);
      expect(await scan(tx, s, s.ana, "current_date - 40")).toMatch(/horizon_scan_from_date/);
      expect(await scan(tx, s, s.ana)).toBeUndefined();
    });
  });

  it("holds a workspace to 100 scans, counting those the caller cannot see", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows(
        `insert into apps.horizon_scan (workspace_id, owner_id, name, purpose, sources, from_date)
         select $1, $2, 'n', 'p', array['fr'], current_date from generate_series(1, 99)`,
        [s.acme, s.ben],
      );
      await tx.as(s.ana, s.acme);
      expect(await scan(tx, s, s.ana)).toMatch(/too many scans/);
    });
  });

  it("lets nobody rewrite what was found, who owns a scan or what was spent", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      for (const sql of [
        "update apps.horizon_item set explanation = 'x'",
        "delete from apps.horizon_item",
        "update apps.horizon_scan set owner_id = owner_id",
        "update apps.horizon_scan set created_at = now() - interval '1 year'",
        "update apps.horizon_spend set usd = 0",
        "update apps.horizon_spend set settled = false",
        "delete from apps.horizon_spend",
      ]) {
        expect(await tx.error(sql)).toMatch(/permission denied/);
      }
    });
  });

  it("settles a reservation once, for whoever made it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { id } = await tx.one<{ id: string }>(
        `insert into apps.horizon_spend (workspace_id, owner_id, usd, settled)
         values ($1, $2, 0.1, false) returning id`,
        [s.acme, s.ana],
      );
      const settle = (usd: number) =>
        tx.rows("select apps.settle_horizon_spend($1, $2)", [id, usd]);
      const usd = async () =>
        Number((await tx.one("select usd from apps.horizon_spend where id = $1", [id])).usd);
      await tx.as(s.ben, s.acme);
      await settle(0);
      await tx.as(s.ana, s.acme);
      expect(await usd()).toBe(0.1);
      await settle(0.02);
      await settle(0);
      expect(await usd()).toBe(0.02);
    });
  });

  it("takes the whole of a deleted scan with it, but not what it cost", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("delete from apps.horizon_scan");
      await tx.asOwner();
      const left = await tx.rows(
        `select 1 from apps.horizon_item where workspace_id = $1
         union all select 1 from apps.horizon_cursor where workspace_id = $1
         union all select 1 from apps.horizon_item_state where workspace_id = $1`,
        [s.acme],
      );
      expect(left).toEqual([]);
      expect(
        await tx.rows("select 1 from apps.horizon_spend where workspace_id = $1", [s.acme]),
      ).toHaveLength(1);
    });
  });

  it("gives the worker only what is due, where scanning is on", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const claim = () =>
        tx.rows("select * from apps.claim_horizon_scan(now() + interval '1 second', 60, $1)", [
          s.acme,
        ]);
      await tx.asWorker();
      expect(await tx.error("select * from apps.horizon_scan")).toMatch(/permission denied/);
      expect(await claim()).toEqual([
        {
          id: s.horizons.acme.scanId,
          workspace_id: s.acme,
          owner_id: s.ana,
          lease: expect.any(String),
          revision: 1,
        },
      ]);
      // Held for the lease.
      expect(await claim()).toEqual([]);
      await tx.asOwner();
      await tx.rows("update apps.horizon_scan set next_refresh_at = now()");
      await tx.rows("update apps.horizon_settings set enabled = false");
      await tx.asWorker();
      expect(await claim()).toEqual([]);
      await tx.rows("select apps.stop_horizon_scan($1)", [s.horizons.acme.scanId]);
      await tx.asOwner();
      expect(
        await tx.rows("select action from admin.audit_event where object_id = $1", [
          s.horizons.acme.scanId,
        ]),
      ).toEqual([{ action: "horizon.scan.stopped" }]);
    });
  });
});
