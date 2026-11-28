import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const count = async (tx: Tx, table: string) =>
  Number((await tx.one<{ n: string }>(`select count(*) n from work.${table}`)).n);

describe("web search in the database", () => {
  it("is turned on and kept from matters only with admin.config", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      // Everyone reads the switch and the list, so they can be held to them.
      expect(await count(tx, "web_settings")).toBe(1);
      expect(await count(tx, "web_blocked_matter")).toBe(1);
      await tx.rows("update work.web_settings set enabled = false");
      await tx.rows("delete from work.web_blocked_matter");
      expect(
        await tx.error(
          "insert into work.web_blocked_matter (workspace_id, matter_id) values ($1, $2)",
          [s.acme, s.matters.m2],
        ),
      ).toMatch(/row-level security/);
      await tx.asOwner();
      expect(
        (await tx.one("select enabled from work.web_settings where workspace_id = $1", [s.acme]))
          .enabled,
      ).toBe(true);
      expect(await count(tx, "web_blocked_matter")).toBe(2);
    });
  });

  it("shows a fetched page to the run's owner alone", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await count(tx, "web_fetch_cache")).toBe(1);
      await tx.as(s.ben, s.acme);
      expect(await count(tx, "web_fetch_cache")).toBe(0);
      expect(
        await tx.error(
          `insert into work.web_fetch_cache (workspace_id, run_id, url, title, text, fetched_at)
           values ($1, $2, 'https://example.org/b', '', 'x', now())`,
          [s.acme, s.threads.acme.runId],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("keeps a page no more than a day, and only the purge job removes it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          `insert into work.web_fetch_cache
             (workspace_id, run_id, url, title, text, fetched_at, expires_at)
           values ($1, $2, 'https://example.org/b', '', 'x', now(), now() + interval '2 days')`,
          [s.acme, s.threads.acme.runId],
        ),
      ).toMatch(/check constraint/);
      expect(await tx.error("delete from work.web_fetch_cache")).toMatch(/permission denied/);
      expect(await tx.error("select work.purge_web_fetch_cache()")).toMatch(/permission denied/);
      await tx.asOwner();
      await tx.rows("update work.web_fetch_cache set expires_at = now() where workspace_id = $1", [
        s.acme,
      ]);
      await tx.rows("set local role legallabs_worker");
      expect((await tx.one<{ n: string }>("select work.purge_web_fetch_cache() n")).n).toBe("1");
      await tx.asOwner();
      expect(await count(tx, "web_fetch_cache")).toBe(1);
    });
  });

  it("takes a verified web citation only with its page and when it was read", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const insert = (ordinal: number, url: string | null) =>
        tx.error(
          `insert into work.citation (workspace_id, message_id, ordinal, anchor, kind, quote,
             status, web_url, web_title, web_fetched_at)
           values ($1, $2, $3, 0, 'web', 'q', 'ok', $4, 'T', now())`,
          [s.acme, s.threads.acme.messageId, ordinal, url],
        );
      expect(await insert(5, "https://example.org/a")).toBeUndefined();
      expect(await insert(6, null)).toMatch(/citation_ok_located/);
      expect(await insert(7, "javascript:alert(1)")).toMatch(/check constraint/);
    });
  });
});
