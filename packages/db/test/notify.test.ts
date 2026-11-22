import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

const EMIT = `select * from notify.emit($1, 'threads', 'task', $2, $3, null, $4, false, '[]'::jsonb,
  '#/t/x', $5, $6::uuid[])`;

interface Emitted {
  user_id: string;
  notification_id: string;
  count: number;
  merged: boolean;
}

// Emits as `actor` (or as a system event for `actor` = null, still run by `runner`).
async function emit(
  tx: Tx,
  s: Seed,
  runner: string,
  object: string,
  recipients: string[],
  opts: { kind?: string; title?: string; actor?: string | null; matter?: string | null } = {},
) {
  await tx.as(runner, s.acme);
  return tx.rows<Emitted & Record<string, unknown>>(EMIT, [
    opts.kind ?? "thread.shared",
    object,
    opts.title ?? "A thread",
    opts.actor === undefined ? runner : opts.actor,
    opts.matter ?? null,
    recipients,
  ]);
}

const inbox = async (tx: Tx, user: string, ws: string) => {
  await tx.as(user, ws);
  return tx.rows<{
    id: string;
    kind: string;
    count: number;
    title: string;
    read_at: string | null;
  }>("select id, kind, count, title, read_at from notify.notification order by created_at");
};

describe("notifications", () => {
  it("are private to their recipient, even from an admin or another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await emit(tx, s, s.ana, randomUUID(), [s.ben, s.cal]);
      expect(await inbox(tx, s.ben, s.acme)).toHaveLength(1);
      expect(await inbox(tx, s.cal, s.acme)).toHaveLength(1);
      expect(await inbox(tx, s.ana, s.acme)).toHaveLength(0);
      expect((await inbox(tx, s.bob, s.beta)).filter((n) => n.title === "A thread")).toHaveLength(
        0,
      );
      await tx.as(s.ben, s.acme);
      expect(
        await tx.rows("select 1 from notify.notification where user_id = $1", [s.cal]),
      ).toHaveLength(0);
    });
  });

  it("can't be inserted, deleted or reassigned by the app role", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await emit(tx, s, s.ana, randomUUID(), [s.ben]);
      await tx.as(s.ben, s.acme);
      const insert = await tx.error(
        `insert into notify.notification (workspace_id, user_id, kind, category, object_type,
           object_id, title, url) values ($1, $2, 'thread.shared', 'threads', 'thread', $3, 't', 'u')`,
        [s.acme, s.ben, randomUUID()],
      );
      expect(insert).toMatch(/permission denied/);
      expect(await tx.error("delete from notify.notification")).toMatch(/permission denied/);
      expect(await tx.error("update notify.notification set user_id = $1", [s.cal])).toMatch(
        /permission denied/,
      );
      expect(await tx.error("update notify.notification set title = 'x'")).toMatch(
        /permission denied/,
      );
    });
  });

  it("let the recipient mark read, archive and mark done, only on their own rows", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await emit(tx, s, s.ana, randomUUID(), [s.ben, s.cal]);
      await tx.as(s.ben, s.acme);
      const done = await tx.rows(
        "update notify.notification set read_at = now(), archived_at = now(), done_at = now() returning id",
      );
      expect(done).toHaveLength(1);
      await tx.as(s.cal, s.acme);
      expect(await inbox(tx, s.cal, s.acme)).toMatchObject([{ read_at: null }]);
    });
  });
});

describe("notify.emit", () => {
  it("never notifies the actor, even when they are listed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const out = await emit(tx, s, s.ben, randomUUID(), [s.ben, s.cal]);
      expect(out.map((r) => r.user_id)).toEqual([s.cal]);
      expect(await inbox(tx, s.ben, s.acme)).toHaveLength(0);
    });
  });

  it("refuses to name someone else as the actor", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const error = await tx.error(EMIT, [
        "thread.shared",
        randomUUID(),
        "t",
        s.ana,
        null,
        [s.cal],
      ]);
      expect(error).toMatch(/FORBIDDEN/);
    });
  });

  it("needs an active member of the workspace to call it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.sue, s.acme);
      expect(
        await tx.error(EMIT, ["thread.shared", randomUUID(), "t", null, null, [s.ben]]),
      ).toMatch(/FORBIDDEN/);
      await tx.as(null, s.acme);
      expect(
        await tx.error(EMIT, ["thread.shared", randomUUID(), "t", null, null, [s.ben]]),
      ).toMatch(/FORBIDDEN/);
    });
  });

  it("is a system event with no actor, and skips suspended users and other workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const out = await emit(tx, s, s.ana, randomUUID(), [s.ana, s.sue, s.bob, s.ben], {
        actor: null,
      });
      expect(out.map((r) => r.user_id).sort()).toEqual([s.ana, s.ben].sort());
      expect((await inbox(tx, s.bob, s.beta)).filter((n) => n.title === "A thread")).toHaveLength(
        0,
      );
    });
  });

  it("checks the wall for each recipient at emission", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // m2 is open but cal is denied; m1 is an allow list that ben is denied from.
      const open = await emit(tx, s, s.ana, randomUUID(), [s.ben, s.cal], {
        matter: s.matters.m2,
      });
      expect(open.map((r) => r.user_id)).toEqual([s.ben]);
      const closed = await emit(tx, s, s.ana, randomUUID(), [s.ben, s.cal], {
        matter: s.matters.m1,
      });
      expect(closed.map((r) => r.user_id)).not.toContain(s.ben);
      expect(await inbox(tx, s.cal, s.acme)).toHaveLength(0);
    });
  });

  it("merges the same kind on the same object within ten minutes into one with a count", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const object = randomUUID();
      const first = await emit(tx, s, s.ana, object, [s.ben], { title: "one" });
      const second = await emit(tx, s, s.ana, object, [s.ben], { title: "two" });
      const third = await emit(tx, s, s.ana, object, [s.ben], { title: "three" });
      expect(first[0]).toMatchObject({ count: 1, merged: false });
      expect(second[0]).toMatchObject({ count: 2, merged: true });
      expect(third[0]).toMatchObject({ count: 3, merged: true });
      expect(third[0]?.notification_id).toBe(first[0]?.notification_id);
      expect(await inbox(tx, s.ben, s.acme)).toMatchObject([{ count: 3, title: "three" }]);
    });
  });

  it("starts a new notification after ten minutes, once read, or for another object or kind", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const object = randomUUID();
      await emit(tx, s, s.ana, object, [s.ben]);
      await tx.asOwner();
      await tx.rows(
        "update notify.notification set created_at = now() - interval '11 minutes' where user_id = $1",
        [s.ben],
      );
      await emit(tx, s, s.ana, object, [s.ben]);
      expect(await inbox(tx, s.ben, s.acme)).toHaveLength(2);

      await tx.as(s.ben, s.acme);
      await tx.rows("update notify.notification set read_at = now()");
      await emit(tx, s, s.ana, object, [s.ben]);
      expect(await inbox(tx, s.ben, s.acme)).toHaveLength(3);

      await emit(tx, s, s.ana, randomUUID(), [s.ben]);
      await emit(tx, s, s.ana, object, [s.ben], { kind: "thread.mentioned" });
      expect(await inbox(tx, s.ben, s.acme)).toHaveLength(5);
    });
  });

  it("leaves another recipient's or workspace's notifications untouched when merging", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const object = randomUUID();
      await emit(tx, s, s.ana, object, [s.ben, s.cal]);
      await emit(tx, s, s.ana, object, [s.ben]);
      expect(await inbox(tx, s.ben, s.acme)).toMatchObject([{ count: 2 }]);
      expect(await inbox(tx, s.cal, s.acme)).toMatchObject([{ count: 1 }]);
      await tx.as(s.bob, s.beta);
      const beta = await tx.rows(EMIT, ["thread.shared", object, "t", null, null, [s.bob]]);
      expect(beta).toMatchObject([{ count: 1, merged: false }]);
    });
  });
});

describe("workspace notification settings", () => {
  it("are readable by members and writable only with admin.config", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        `insert into notify.workspace_notification_pref (workspace_id, category, default_value, locked)
         values ($1, 'vault', false, true)`,
        [s.acme],
      );
      await tx.rows(
        "insert into notify.workspace_notification_setting (workspace_id, include_content) values ($1, true)",
        [s.acme],
      );
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select * from notify.workspace_notification_pref")).toHaveLength(1);
      expect(await tx.rows("select * from notify.workspace_notification_setting")).toHaveLength(1);
      expect(
        await tx.error(
          "insert into notify.workspace_notification_pref (workspace_id, category) values ($1, 'threads')",
          [s.acme],
        ),
      ).toMatch(/row-level security/);
      await tx.rows("update notify.workspace_notification_pref set locked = false");
      await tx.asOwner();
      expect(
        await tx.rows<{ locked: boolean }>(
          "select locked from notify.workspace_notification_pref where workspace_id = $1 and category = 'vault'",
          [s.acme],
        ),
      ).toMatchObject([{ locked: true }]);
      await tx.as(s.ben, s.acme);
      await tx.rows("update notify.workspace_notification_setting set include_content = false");
      await tx.asOwner();
      expect(
        await tx.rows<{ include_content: boolean }>(
          "select include_content from notify.workspace_notification_setting where workspace_id = $1",
          [s.acme],
        ),
      ).toMatchObject([{ include_content: true }]);
      // dee holds admin.users but not admin.config.
      await tx.as(s.dee, s.acme);
      expect(
        await tx.error(
          "insert into notify.workspace_notification_setting (workspace_id) values ($1)",
          [s.acme],
        ),
      ).toMatch(/row-level security|duplicate/);
    });
  });

  it("don't reach another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(
        "insert into notify.workspace_notification_pref (workspace_id, category) values ($1, 'vault')",
        [s.acme],
      );
      await tx.as(s.bob, s.beta);
      expect(
        await tx.rows("select 1 from notify.workspace_notification_pref where workspace_id = $1", [
          s.acme,
        ]),
      ).toHaveLength(0);
      expect(
        await tx.error(
          "insert into notify.workspace_notification_pref (workspace_id, category) values ($1, 'vault')",
          [s.acme],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("keep personal preferences and quiet hours to their owner", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        "insert into notify.notification_pref (workspace_id, user_id, category, value) values ($1, $2, 'vault', true)",
        [s.acme, s.ben],
      );
      await tx.rows(
        `insert into notify.notification_quiet_hours (workspace_id, user_id, from_local, to_local, tz)
         values ($1, $2, '22:00', '07:00', 'Australia/Sydney')`,
        [s.acme, s.ben],
      );
      expect(
        await tx.error(
          "insert into notify.notification_pref (workspace_id, user_id, category, value) values ($1, $2, 'vault', true)",
          [s.acme, s.cal],
        ),
      ).toMatch(/row-level security/);
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select * from notify.notification_pref")).toHaveLength(0);
      expect(await tx.rows("select * from notify.notification_quiet_hours")).toHaveLength(0);
    });
  });
});

describe("email outbox", () => {
  it("is readable only by its user and not writable by the app role", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows(
        `insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload)
         values ($1, $2, 'threads', 'k', '{}')`,
        [s.acme, s.ben],
      );
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select * from notify.email_outbox")).toHaveLength(1);
      expect(
        await tx.error(
          `insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload)
           values ($1, $2, 'threads', 'k', '{}')`,
          [s.acme, s.ben],
        ),
      ).toMatch(/permission denied/);
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select * from notify.email_outbox")).toHaveLength(0);
    });
  });
});

describe("notify.purge", () => {
  it("archives items unavailable for a week, deletes old unread and archived ones, and is worker-only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          ...(await emit(tx, s, s.ana, randomUUID(), [s.ben])).map((r) => r.notification_id),
        );
      }
      await tx.asOwner();
      const set = (id: string, sql: string) =>
        tx.rows(`update notify.notification set ${sql} where id = $1`, [id]);
      await set(
        ids[0] as string,
        "available = false, unavailable_since = now() - interval '8 days'",
      );
      await set(
        ids[1] as string,
        "available = false, unavailable_since = now() - interval '2 days'",
      );
      await set(ids[2] as string, "created_at = now() - interval '91 days'");
      await set(ids[3] as string, "archived_at = now() - interval '31 days'");
      // ids[4] stays fresh.

      await tx.as(s.ben, s.acme);
      expect(await tx.error("select * from notify.purge()")).toMatch(/permission denied/);

      await tx.asWorker();
      const [result] = await tx.rows<{ archived: number; deleted: number }>(
        "select * from notify.purge()",
      );
      expect(result).toEqual({ archived: 1, deleted: 2 });

      await tx.asOwner();
      const left = await tx.rows<{ id: string; archived_at: string | null }>(
        "select id, archived_at from notify.notification where user_id = $1 order by created_at",
        [s.ben],
      );
      expect(left.map((r) => r.id).sort()).toEqual([ids[0], ids[1], ids[4]].sort());
      expect(left.find((r) => r.id === ids[0])?.archived_at).not.toBeNull();
      expect(left.find((r) => r.id === ids[1])?.archived_at).toBeNull();
    });
  });
});
