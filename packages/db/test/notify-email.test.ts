import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

// A notification for `to`, made by `from` (system event when null), then queued for email.
// `content` becomes the notification's body, the source of the mail's excerpt.
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
    title?: string;
  } = {},
) {
  await tx.as(s.ana, s.acme);
  const made = await tx.one<{ notification_id: string }>(
    `select * from notify.emit('thread.shared', $1, 'task', $2, $6, $7, $3, $4, '[]'::jsonb,
       '#/t/x', null, $5::uuid[])`,
    [
      o.category ?? "threads",
      randomUUID(),
      o.from === undefined ? s.ana : o.from,
      o.action ?? false,
      [to],
      o.title ?? "Title",
      o.content ?? null,
    ],
  );
  const queued = await tx.one<{ n: number }>("select notify.enqueue_email($1::uuid[], $2, $3) n", [
    [made.notification_id],
    o.long ?? false,
    o.completion ?? false,
  ]);
  return { id: made.notification_id, queued: queued.n };
}

// The transaction's own clock, which is what the functions under test read.
const clock = async (tx: Tx) => (await tx.one<{ t: Date }>("select now() t")).t;

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
      expect((await make(tx, s, s.ben, { action: true })).queued).toBe(1);
      expect((await make(tx, s, s.ben, { action: false })).queued).toBe(0);
      const rows = await outboxOf(tx, s.ben, s.acme);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scheduled_at.toISOString()).toBe((await clock(tx)).toISOString());
      expect(rows[0]?.payload).toMatchObject({ subject: "Title", action_required: true });
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
          await tx.one<{ n: number }>("select notify.enqueue_email($1::uuid[], false, false) n", [
            [randomUUID()],
          ])
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
        "select notify.enqueue_email($1::uuid[], false, false) n",
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
      await make(tx, s, s.ben);
      await make(tx, s, s.ben);
      const rows = await outboxOf(tx, s.ben, s.acme);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.batch_key).toBe(rows[1]?.batch_key);
      const now = (await clock(tx)).getTime();
      const due = (rows[0]?.scheduled_at.getTime() ?? 0) - now;
      expect(due).toBeGreaterThan(0);
      expect(due).toBeLessThanOrEqual(15 * 60 * 1000);
    });
  });

  it("holds plain mail until quiet hours end when queued inside them; action-required ignores them", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into notify.notification_pref (workspace_id, user_id, category, value, mode)
         values ($1, $2, 'threads', true, 'all')`,
        [s.acme, s.ben],
      );
      // Quiet hours from an hour ago until an hour ahead, in UTC, so "now" is inside them.
      const win = await tx.one<{ f: string; t: string }>(
        `select to_char(now() at time zone 'UTC' - interval '1 hour', 'HH24:MI') f,
                to_char(now() at time zone 'UTC' + interval '1 hour', 'HH24:MI') t`,
      );
      await tx.rows(
        `insert into notify.notification_quiet_hours (workspace_id, user_id, from_local, to_local, tz)
         values ($1, $2, $3, $4, 'UTC')`,
        [s.acme, s.ben, win.f, win.t],
      );
      await make(tx, s, s.ben);
      await make(tx, s, s.ben, { action: true });
      const rows = await outboxOf(tx, s.ben, s.acme);
      const now = (await clock(tx)).getTime();
      const plain = rows.find((r) => r.payload.action_required !== true);
      const urgent = rows.find((r) => r.payload.action_required === true);
      expect((plain?.scheduled_at.getTime() ?? 0) - now).toBeGreaterThan(50 * 60 * 1000);
      expect(urgent?.scheduled_at.getTime()).toBe(now);
    });
  });

  it("takes its words from the notification, never from the caller", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await make(tx, s, s.ben, { action: true, title: "Real title", content: "Real body" });
      const rows = await outboxOf(tx, s.ben, s.acme);
      expect(rows[0]?.payload).toMatchObject({ subject: "Real title", text: "Real title" });
      // The old shapes, with subject, text or a clock passed in, no longer exist.
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("select notify.enqueue_email($1::uuid[], 's', 't', null, false, false)", [
          [randomUUID()],
        ]),
      ).toMatch(/does not exist/);
      expect(
        await tx.error(
          "select notify.enqueue_email($1::uuid[], 's', 't', null, false, false, now())",
          [[randomUUID()]],
        ),
      ).toMatch(/does not exist/);
    });
  });

  it("queues only notifications the caller made, not another person's", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // Ana notifies Ben (actor Ana) without queueing mail; Cal can't queue it.
      await tx.as(s.ana, s.acme);
      const made = await tx.one<{ notification_id: string }>(
        `select * from notify.emit('thread.shared', 'threads', 'task', $1, 'Hi', null, $2, true,
           '[]'::jsonb, '#/t/x', null, $3::uuid[])`,
        [randomUUID(), s.ana, [s.ben]],
      );
      const queue = () =>
        tx.one<{ n: number }>("select notify.enqueue_email($1::uuid[], false, false) n", [
          [made.notification_id],
        ]);
      await tx.as(s.cal, s.acme);
      expect((await queue()).n).toBe(0);
      await tx.as(s.ana, s.acme);
      expect((await queue()).n).toBe(1);
    });
  });

  it("is refused outside a workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      expect(
        await tx.error("select notify.enqueue_email($1::uuid[], false, false)", [[randomUUID()]]),
      ).toMatch(/FORBIDDEN/);
      await tx.as(s.ana, s.acme);
    });
  });
});

describe("notify.email_due", () => {
  const due = async (
    tx: Tx,
    now: string,
    action: boolean,
    quiet: [string, string, string] | null,
  ) =>
    (
      await tx.one<{ d: Date }>(
        "select notify.email_due($1::timestamptz, $2, $3, $4::time, $5::time) d",
        [now, action, quiet?.[2] ?? null, quiet?.[0] ?? null, quiet?.[1] ?? null],
      )
    ).d.toISOString();

  it("sends action-required mail now and plain mail at the next 15-minute window", async () => {
    await withTx(async (tx) => {
      expect(await due(tx, "2026-03-10T12:03:00Z", true, null)).toBe("2026-03-10T12:03:00.000Z");
      expect(await due(tx, "2026-03-10T12:03:00Z", false, null)).toBe("2026-03-10T12:15:00.000Z");
      expect(await due(tx, "2026-03-10T12:11:00Z", false, null)).toBe("2026-03-10T12:15:00.000Z");
      expect(await due(tx, "2026-03-10T12:16:00Z", false, null)).toBe("2026-03-10T12:30:00.000Z");
    });
  });

  it("holds plain mail to the end of quiet hours that wrap midnight; action-required ignores them", async () => {
    await withTx(async (tx) => {
      const q: [string, string, string] = ["22:00", "07:00", "America/New_York"];
      // 23:00 New York (EDT, UTC-4) on 10 March 2026 is 03:00Z on the 11th.
      expect(await due(tx, "2026-03-11T03:00:00Z", false, q)).toBe("2026-03-11T11:00:00.000Z");
      // 01:00 local the same night: still inside quiet hours, same end.
      expect(await due(tx, "2026-03-11T05:00:00Z", false, q)).toBe("2026-03-11T11:00:00.000Z");
      // 12:00 local is outside quiet hours: next window.
      expect(await due(tx, "2026-03-11T16:00:00Z", false, q)).toBe("2026-03-11T16:15:00.000Z");
      expect(await due(tx, "2026-03-11T03:00:00Z", true, q)).toBe("2026-03-11T03:00:00.000Z");
    });
  });

  it("handles quiet hours that stay inside one day", async () => {
    await withTx(async (tx) => {
      const q: [string, string, string] = ["12:00", "13:00", "UTC"];
      expect(await due(tx, "2026-03-10T12:30:00Z", false, q)).toBe("2026-03-10T13:00:00.000Z");
      expect(await due(tx, "2026-03-10T13:30:00Z", false, q)).toBe("2026-03-10T13:45:00.000Z");
    });
  });
});

describe("notify.enqueue_email excerpt and outbox", () => {
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
        await tx.error("select notify.enqueue_email($1::uuid[], false, false)", [[randomUUID()]]),
      ).toMatch(/FORBIDDEN/);
    });
  });
});

describe("email worker functions", () => {
  it("claim due rows for the worker only, lease them, and record sends on the notification", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // The fixtures queue mail of their own; this test is about the one made here.
      await tx.asOwner();
      await tx.rows("delete from notify.email_outbox");
      const a = await make(tx, s, s.ben, { action: true });
      const t0 = (await clock(tx)).getTime();
      const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
      await tx.as(s.ben, s.acme);
      expect(await tx.error("select * from notify.claim_email()")).toMatch(/permission denied/);

      await tx.asWorker();
      expect(await tx.rows("select * from notify.claim_email($1)", [at(-60)])).toHaveLength(0);
      const claimed = await tx.rows<{ id: string; to_email: string; attempts: number }>(
        "select * from notify.claim_email($1)",
        [at(1)],
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.to_email).toMatch(/@/);
      expect(claimed[0]?.attempts).toBe(1);
      // Leased: a second claim right away finds nothing; after the lease it comes back.
      expect(await tx.rows("select * from notify.claim_email($1)", [at(60)])).toHaveLength(0);
      expect(await tx.rows("select * from notify.claim_email($1)", [at(660)])).toHaveLength(1);

      const ids = claimed.map((c) => c.id);
      await tx.rows("select notify.mark_email_error($1::uuid[], 'smtp down', $2)", [ids, at(660)]);
      await tx.rows("select notify.mark_email_sent($1::uuid[], $2)", [ids, at(1200)]);
      expect(await tx.rows("select * from notify.claim_email($1)", [at(3600)])).toHaveLength(0);

      await tx.as(s.ben, s.acme);
      const n = await tx.one<{ email_sent_at: Date | null }>(
        "select email_sent_at from notify.notification where id = $1",
        [a.id],
      );
      expect(n.email_sent_at?.toISOString()).toBe(at(1200));
    });
  });

  it("back off after an error and stop after five attempts", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows("delete from notify.email_outbox");
      await make(tx, s, s.ben, { action: true });
      await tx.asWorker();
      let at = (await clock(tx)).getTime() + 1000;
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
