import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

// A notification for `to`, made by `from` (system event when null), then queued for email.
async function make(
  tx: Tx,
  s: Seed,
  to: string,
  o: {
    category?: string;
    action?: boolean;
    from?: string | null;
    long?: boolean;
    completion?: boolean;
    content?: string | null;
    now?: string | null;
  } = {},
) {
  await tx.as(s.ana, s.acme);
  const made = await tx.one<{ notification_id: string }>(
    `select * from notify.emit('thread.shared', $1, 'thread', $2, 'Title', null, $3, $4, '[]'::jsonb,
       '#/t/x', null, $5::uuid[])`,
    [
      o.category ?? "threads",
      randomUUID(),
      o.from === undefined ? s.ana : o.from,
      o.action ?? false,
      [to],
    ],
  );
  const queued = await tx.one<{ n: number }>(
    "select notify.enqueue_email($1::uuid[], 'Subject', 'Text', $2, $3, $4, $5) n",
    [
      [made.notification_id],
      o.content ?? null,
      o.long ?? false,
      o.completion ?? false,
      o.now ?? null,
    ],
  );
  return { id: made.notification_id, queued: queued.n };
}

const outboxOf = async (tx: Tx, user: string, ws: string) => {
  await tx.as(user, ws);
  return tx.rows<{
    batch_key: string;
    scheduled_at: Date;
    payload: Record<string, string | boolean>;
    notification_id: string;
  }>("select batch_key, scheduled_at, payload, notification_id from notify.email_outbox");
};

describe("notify.enqueue_email", () => {
  it("queues action-required mail now and skips plain events in action-only mode", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const now = "2026-03-10T12:00:00Z";
      expect((await make(tx, s, s.ben, { action: true, now })).queued).toBe(1);
      expect((await make(tx, s, s.ben, { action: false, now })).queued).toBe(0);
      const rows = await outboxOf(tx, s.ben, s.acme);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scheduled_at.toISOString()).toBe("2026-03-10T12:00:00.000Z");
      expect(rows[0]?.payload).toMatchObject({ subject: "Subject", action_required: true });
    });
  });

  it("emails a long run's completion in action-only mode, but not a short one", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect((await make(tx, s, s.ben, { completion: true, long: false })).queued).toBe(0);
      expect((await make(tx, s, s.ben, { completion: true, long: true })).queued).toBe(1);
    });
  });

  it("emails everything when the person chose all events", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into notify.notification_pref (workspace_id, user_id, category, value, mode)
         values ($1, $2, 'threads', true, 'all')`,
        [s.acme, s.ben],
      );
      expect((await make(tx, s, s.ben)).queued).toBe(1);
    });
  });

  it("follows the effective toggle: a locked workspace value beats the person's choice", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        `insert into notify.workspace_notification_pref (workspace_id, category, default_value, locked)
         values ($1, 'threads', false, true), ($1, 'vault', false, false)`,
        [s.acme],
      );
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into notify.notification_pref (workspace_id, user_id, category, value)
         values ($1, $2, 'threads', true), ($1, $2, 'vault', true)`,
        [s.acme, s.ben],
      );
      // Locked off: the person's "on" is ignored. Unlocked default off: their own value wins.
      expect((await make(tx, s, s.ben, { action: true })).queued).toBe(0);
      expect((await make(tx, s, s.ben, { action: true, category: "vault" })).queued).toBe(1);
      // Someone without a choice gets the unlocked workspace default (off).
      expect((await make(tx, s, s.cal, { action: true, category: "vault" })).queued).toBe(0);
    });
  });

  it("never emails the memory category, and never to a recipient with no notification", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect((await make(tx, s, s.ben, { category: "memory", action: true })).queued).toBe(0);
      await tx.as(s.ana, s.acme);
      expect(
        (
          await tx.one<{ n: number }>(
            "select notify.enqueue_email($1::uuid[], 's', 't', null, false, false) n",
            [[randomUUID()]],
          )
        ).n,
      ).toBe(0);
    });
  });

  it("queues a notification only once", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const first = await make(tx, s, s.ben, { action: true });
      await tx.as(s.ana, s.acme);
      const again = await tx.one<{ n: number }>(
        "select notify.enqueue_email($1::uuid[], 's', 't', null, false, false) n",
        [[first.id]],
      );
      expect(again.n).toBe(0);
    });
  });

  it("batches plain mail into the next 15-minute window per person", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into notify.notification_pref (workspace_id, user_id, category, value, mode)
         values ($1, $2, 'threads', true, 'all')`,
        [s.acme, s.ben],
      );
      await make(tx, s, s.ben, { now: "2026-03-10T12:03:00Z" });
      await make(tx, s, s.ben, { now: "2026-03-10T12:11:00Z" });
      await make(tx, s, s.ben, { now: "2026-03-10T12:16:00Z" });
      const rows = await outboxOf(tx, s.ben, s.acme);
      const keys = rows.map((r) => r.batch_key);
      expect(new Set(keys).size).toBe(2);
      expect(keys[0]).toBe(keys[1]);
      expect(rows[0]?.scheduled_at.toISOString()).toBe("2026-03-10T12:15:00.000Z");
      expect(rows[2]?.scheduled_at.toISOString()).toBe("2026-03-10T12:30:00.000Z");
    });
  });

  it("holds plain mail to the end of quiet hours that wrap midnight; action-required ignores them", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into notify.notification_pref (workspace_id, user_id, category, value, mode)
         values ($1, $2, 'threads', true, 'all')`,
        [s.acme, s.ben],
      );
      await tx.rows(
        `insert into notify.notification_quiet_hours (workspace_id, user_id, from_local, to_local, tz)
         values ($1, $2, '22:00', '07:00', 'America/New_York')`,
        [s.acme, s.ben],
      );
      // 23:00 New York (EDT, UTC-4) on 10 March 2026 is 03:00Z on the 11th.
      await make(tx, s, s.ben, { now: "2026-03-11T03:00:00Z" });
      // 01:00 local the same night: still inside quiet hours, same end.
      await make(tx, s, s.ben, { now: "2026-03-11T05:00:00Z" });
      // 12:00 local is outside quiet hours: next window.
      await make(tx, s, s.ben, { now: "2026-03-11T16:00:00Z" });
      await make(tx, s, s.ben, { action: true, now: "2026-03-11T03:00:00Z" });
      const rows = await outboxOf(tx, s.ben, s.acme);
      const at = rows.map((r) => r.scheduled_at.toISOString());
      expect(at[0]).toBe("2026-03-11T11:00:00.000Z"); // 07:00 EDT
      expect(at[1]).toBe("2026-03-11T11:00:00.000Z");
      expect(rows[0]?.batch_key).toBe(rows[1]?.batch_key);
      expect(at[2]).toBe("2026-03-11T16:15:00.000Z");
      expect(at[3]).toBe("2026-03-11T03:00:00.000Z");
    });
  });

  it("keeps the comment excerpt only when the workspace allows content, cut to 300 characters", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const long = "x".repeat(500);
      await make(tx, s, s.ben, { action: true, content: long });
      await tx.as(s.ana, s.acme);
      await tx.rows(
        "insert into notify.workspace_notification_setting (workspace_id, include_content) values ($1, true)",
        [s.acme],
      );
      await make(tx, s, s.ben, { action: true, content: long });
      const rows = await outboxOf(tx, s.ben, s.acme);
      expect(rows[0]?.payload.excerpt).toBeUndefined();
      expect(String(rows[1]?.payload.excerpt)).toHaveLength(300);
    });
  });

  it("is refused outside a workspace and can't read the outbox of others", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await make(tx, s, s.ben, { action: true });
      expect(await outboxOf(tx, s.cal, s.acme)).toHaveLength(0);
      expect(await outboxOf(tx, s.ana, s.acme)).toHaveLength(0);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          "insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload) values ($1, $2, 'threads', 'k', '{}')",
          [s.acme, s.ben],
        ),
      ).toMatch(/permission denied/);
      await tx.as(null, null);
      expect(
        await tx.error("select notify.enqueue_email($1::uuid[], 's', 't', null, false, false)", [
          [randomUUID()],
        ]),
      ).toMatch(/FORBIDDEN/);
    });
  });
});

describe("email worker functions", () => {
  it("claim due rows for the worker only, lease them, and record sends on the notification", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const a = await make(tx, s, s.ben, { action: true, now: "2026-03-10T12:00:00Z" });
      await tx.as(s.ben, s.acme);
      expect(await tx.error("select * from notify.claim_email()")).toMatch(/permission denied/);

      await tx.asWorker();
      expect(
        await tx.rows("select * from notify.claim_email($1)", ["2026-03-10T11:59:00Z"]),
      ).toHaveLength(0);
      const claimed = await tx.rows<{ id: string; to_email: string; attempts: number }>(
        "select * from notify.claim_email($1)",
        ["2026-03-10T12:00:01Z"],
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.to_email).toMatch(/@/);
      expect(claimed[0]?.attempts).toBe(1);
      // Leased: a second claim right away finds nothing; after the lease it comes back.
      expect(
        await tx.rows("select * from notify.claim_email($1)", ["2026-03-10T12:01:00Z"]),
      ).toHaveLength(0);
      expect(
        await tx.rows("select * from notify.claim_email($1)", ["2026-03-10T12:11:00Z"]),
      ).toHaveLength(1);

      const ids = claimed.map((c) => c.id);
      await tx.rows("select notify.mark_email_error($1::uuid[], 'smtp down', $2)", [
        ids,
        "2026-03-10T12:11:00Z",
      ]);
      await tx.rows("select notify.mark_email_sent($1::uuid[], $2)", [ids, "2026-03-10T12:20:00Z"]);
      expect(
        await tx.rows("select * from notify.claim_email($1)", ["2026-03-10T13:00:00Z"]),
      ).toHaveLength(0);

      await tx.as(s.ben, s.acme);
      const n = await tx.one<{ email_sent_at: Date | null }>(
        "select email_sent_at from notify.notification where id = $1",
        [a.id],
      );
      expect(n.email_sent_at?.toISOString()).toBe("2026-03-10T12:20:00.000Z");
    });
  });

  it("back off after an error and stop after five attempts", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await make(tx, s, s.ben, { action: true, now: "2026-03-10T12:00:00Z" });
      await tx.asWorker();
      let at = Date.parse("2026-03-10T12:00:00Z");
      for (let i = 1; i <= 5; i++) {
        const rows = await tx.rows<{ id: string }>("select * from notify.claim_email($1)", [
          new Date(at).toISOString(),
        ]);
        expect(rows).toHaveLength(1);
        await tx.rows("select notify.mark_email_error($1::uuid[], 'down', $2)", [
          [rows[0]?.id],
          new Date(at).toISOString(),
        ]);
        at += i * 5 * 60 * 1000 + 1000;
      }
      expect(
        await tx.rows("select * from notify.claim_email($1)", [
          new Date(at + 3600e3).toISOString(),
        ]),
      ).toHaveLength(0);
    });
  });
});
