import {
  type AdminNotificationSettings,
  type AdminNotificationSettingsPatch,
  EmailCategory,
  isRelativeLink,
  NOTIFICATION_LIMITS,
  type Notification,
  type NotificationActBody,
  type NotificationActResult,
  type NotificationCounts,
  type NotificationPatch,
  type NotificationQuery,
  type NotificationSettings,
  type NotificationSettingsPatch,
  UNAVAILABLE_LINK,
} from "@legallabs/contracts";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp, asWorker } from "../db.js";
import { ActionRefused, type ActionRegistry, createActionRegistry } from "./actions.js";
import { createHub, type Hub } from "./hub.js";
import { createNotifier, type Notifier } from "./notify.js";

type Db = pg.PoolClient;

export type ActFailure = "NOT_FOUND" | "UNKNOWN_ACTION" | "NO_HANDLER";

export type ActOutcome =
  | { ok: true; result: NotificationActResult; notification: Notification }
  | { ok: false; reason: ActFailure }
  | { ok: false; reason: "REFUSED"; status: 400 | 403 | 404 | 409; code: string; message: string };

export interface NotificationPage {
  items: Notification[];
  unread_count: number;
  action_required_count: number;
  next_cursor?: string;
}

export interface Notifications {
  /** What other modules call to tell people things. */
  notifier: Notifier;
  hub: Hub;
  /** Modules register what an inline action does. */
  actions: ActionRegistry;
  list(p: Principal, query: NotificationQuery): Promise<NotificationPage>;
  counts(p: Principal): Promise<NotificationCounts>;
  /** Re-checks the recipient's access to the object, so a wall shows at once. */
  get(p: Principal, id: string): Promise<Notification | null>;
  readAll(p: Principal): Promise<void>;
  patch(p: Principal, id: string, patch: NotificationPatch): Promise<Notification | null>;
  act(p: Principal, id: string, body: NotificationActBody, client: Client): Promise<ActOutcome>;
  /** New or merged notifications since `since` (with a little overlap), for the stream. */
  changes(
    p: Principal,
    since: string | null,
  ): Promise<{
    items: Notification[];
    /** Each item's creation time in microseconds, so a stream can keep a high-water mark. */
    marks: bigint[];
    counts: NotificationCounts;
    high: string;
  }>;
  settings(p: Principal): Promise<NotificationSettings>;
  patchSettings(
    p: Principal,
    patch: NotificationSettingsPatch,
    client: Client,
  ): Promise<{ ok: true; settings: NotificationSettings } | { ok: false; reason: "INVALID_TZ" }>;
  adminSettings(p: Principal): Promise<AdminNotificationSettings | null>;
  patchAdminSettings(
    p: Principal,
    patch: AdminNotificationSettingsPatch,
    client: Client,
  ): Promise<AdminNotificationSettings | null>;
  /** Archives long-unavailable items and deletes old ones; run by the worker role. */
  purge(): Promise<{ archived: number; deleted: number }>;
}

interface Row {
  id: string;
  kind: string;
  category: Notification["category"];
  object_type: string;
  object_id: string;
  title: string;
  body: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action_required: boolean;
  actions: Notification["actions"];
  url: string;
  count: number;
  available: boolean;
  unavailable_since: Date | null;
  done_at: Date | null;
  created_at: Date;
  created_text: string;
  read_at: Date | null;
  archived_at: Date | null;
}

const COLUMNS = `n.id, n.kind, n.category, n.object_type, n.object_id, n.title, n.body, n.actor_id,
  u.name as actor_name, u.email as actor_email, n.action_required, n.actions, n.url, n.count,
  n.available, n.unavailable_since, n.done_at, n.created_at, n.created_at::text as created_text,
  n.read_at, n.archived_at`;
const FROM = `from notify.notification n left join core."user" u on u.id = n.actor_id`;

const iso = (d: Date | null) => (d ? d.toISOString() : undefined);

/** What a recipient sees once the object is gone: no title, body, actor or actions of the item. */
export const UNAVAILABLE_TITLE = "Item no longer available";

const view = (row: Row): Notification => (row.available ? visible(row) : hidden(row));

const hidden = (row: Row): Notification => ({
  id: row.id,
  kind: row.kind,
  category: row.category,
  object_type: row.object_type,
  object_id: row.object_id,
  title: UNAVAILABLE_TITLE,
  action_required: false,
  url: UNAVAILABLE_LINK,
  created_at: row.created_at.toISOString(),
  ...(row.read_at ? { read_at: iso(row.read_at) as string } : {}),
  ...(row.archived_at ? { archived_at: iso(row.archived_at) as string } : {}),
  ...(row.done_at ? { done_at: iso(row.done_at) as string } : {}),
  count: row.count,
  available: false,
});

const visible = (row: Row): Notification => ({
  id: row.id,
  kind: row.kind,
  category: row.category,
  object_type: row.object_type,
  object_id: row.object_id,
  title: row.title,
  ...(row.body ? { body: row.body } : {}),
  ...(row.actor_id
    ? { actor: { id: row.actor_id, name: row.actor_name || row.actor_email || "Someone" } }
    : {}),
  action_required: row.action_required,
  ...(row.actions && row.actions.length > 0 ? { actions: row.actions } : {}),
  // Rows written before links were checked may hold anything; the API never hands one out.
  url: isRelativeLink(row.url) ? row.url : "#/",
  created_at: row.created_at.toISOString(),
  ...(row.read_at ? { read_at: iso(row.read_at) as string } : {}),
  ...(row.archived_at ? { archived_at: iso(row.archived_at) as string } : {}),
  ...(row.done_at ? { done_at: iso(row.done_at) as string } : {}),
  count: row.count,
  available: row.available,
});

// Object types whose visibility is checked under the recipient's own access; others stay available.
const VISIBLE: Record<string, string> = {
  thread: "select id from work.thread where id = any($1::uuid[])",
  run: `select r.id from work.run r join work.thread t on t.id = r.thread_id
         where r.id = any($1::uuid[])`,
  vault: "select id from content.vault where id = any($1::uuid[])",
  table: "select id from work.review_table where id = any($1::uuid[])",
  playbook: "select id from work.playbook where id = any($1::uuid[])",
  playbook_review: "select id from work.playbook_review where id = any($1::uuid[])",
};

/** Sets `available` from what the recipient can see now, and starts or clears the 7-day clock. */
async function refreshAvailability(db: Db, rows: Row[]): Promise<Row[]> {
  const byType = new Map<string, Row[]>();
  for (const row of rows) {
    if (VISIBLE[row.object_type])
      byType.set(row.object_type, [...(byType.get(row.object_type) ?? []), row]);
  }
  for (const [type, group] of byType) {
    const { rows: seen } = await db.query<{ id: string }>(VISIBLE[type] as string, [
      [...new Set(group.map((r) => r.object_id))],
    ]);
    const visible = new Set(seen.map((r) => r.id));
    for (const row of group) {
      const now = visible.has(row.object_id);
      if (now === row.available) continue;
      await db.query(
        `update notify.notification
            set available = $2, unavailable_since = case when $2 then null else now() end
          where id = $1`,
        [row.id, now],
      );
      row.available = now;
    }
  }
  return rows;
}

const encodeCursor = (row: Row) =>
  Buffer.from(`${row.created_text}|${row.id}`).toString("base64url");
function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  return at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/i.test(id) ? [at, id] : null;
}

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const MAX_PAYLOAD_CHARS = 4096;
const refused = (
  status: 400 | 403 | 404 | 409,
  code: string,
  message: string,
): {
  ok: false;
  reason: "REFUSED";
  status: 400 | 403 | 404 | 409;
  code: string;
  message: string;
} => ({
  ok: false,
  reason: "REFUSED",
  status,
  code,
  message,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createNotifications(
  pool: pg.Pool,
  options: { log?: (line: string) => void; now?: () => Date } = {},
): Notifications {
  const hub = createHub();
  const actions = createActionRegistry();
  const notifier = createNotifier(pool, hub, options.log, options.now ? { now: options.now } : {});

  const countsOf = async (db: Db): Promise<NotificationCounts> => {
    const { rows } = await db.query<{ unread: string; action_required: string }>(
      `select count(*) filter (where read_at is null) as unread,
              count(*) filter (where read_at is null and action_required and done_at is null)
                as action_required
         from notify.notification where archived_at is null`,
    );
    return {
      unread: Number(rows[0]?.unread ?? 0),
      action_required: Number(rows[0]?.action_required ?? 0),
    };
  };

  const one = async (db: Db, id: string) =>
    (await db.query<Row>(`select ${COLUMNS} ${FROM} where n.id = $1`, [id])).rows[0] ?? null;

  const settingsOf = async (db: Db): Promise<NotificationSettings> => {
    const ws = (
      await db.query<{ category: string; default_value: boolean; locked: boolean }>(
        "select category, default_value, locked from notify.workspace_notification_pref",
      )
    ).rows;
    const mine = (
      await db.query<{ category: string; value: boolean; mode: "action_only" | "all" }>(
        "select category, value, mode from notify.notification_pref",
      )
    ).rows;
    const quiet = (
      await db.query<{ from_local: string; to_local: string; tz: string }>(
        "select from_local::text, to_local::text, tz from notify.notification_quiet_hours",
      )
    ).rows[0];
    const include = (
      await db.query<{ include_content: boolean }>(
        "select include_content from notify.workspace_notification_setting",
      )
    ).rows[0];
    return {
      categories: EmailCategory.options.map((category) => {
        const w = ws.find((r) => r.category === category);
        const u = mine.find((r) => r.category === category);
        const workspaceDefault = w?.default_value ?? true;
        const locked = w?.locked ?? false;
        return {
          category,
          ...(u ? { user_value: u.value } : {}),
          workspace_default: workspaceDefault,
          locked,
          // A locked category is the workspace's answer, whatever the person chose.
          effective: locked ? workspaceDefault : (u?.value ?? workspaceDefault),
          mode: u?.mode ?? "action_only",
        };
      }),
      ...(quiet
        ? {
            quiet_hours: {
              from: quiet.from_local.slice(0, 5),
              to: quiet.to_local.slice(0, 5),
              tz: quiet.tz,
            },
          }
        : {}),
      include_content: include?.include_content ?? false,
    };
  };

  const adminOf = async (db: Db): Promise<AdminNotificationSettings> => {
    const s = await settingsOf(db);
    return {
      categories: s.categories.map((c) => ({
        category: c.category,
        default: c.workspace_default,
        locked: c.locked,
      })),
      include_content: s.include_content,
    };
  };

  const canConfigure = async (db: Db) =>
    (await db.query<{ ok: boolean }>("select core.has_permission('admin.config') as ok")).rows[0]
      ?.ok === true;

  return {
    notifier,
    hub,
    actions,

    async list(p, query) {
      return asApp(pool, p, async (db) => {
        const cursor = decodeCursor(query.cursor);
        const where = [
          query.state === "archived" ? "n.archived_at is not null" : "n.archived_at is null",
        ];
        if (query.state === "unread") where.push("n.read_at is null");
        if (query.tab === "action_required") where.push("n.action_required");
        const params: unknown[] = [];
        if (query.category) {
          params.push(query.category);
          where.push(`n.category = $${params.length}`);
        }
        if (cursor) {
          params.push(cursor[0], cursor[1]);
          where.push(
            `(n.created_at, n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        const size = NOTIFICATION_LIMITS.pageSize;
        const { rows } = await db.query<Row>(
          `select ${COLUMNS} ${FROM} where ${where.join(" and ")}
            order by n.created_at desc, n.id desc limit ${size + 1}`,
          params,
        );
        const page = rows.slice(0, size);
        const last = page[page.length - 1];
        await refreshAvailability(db, page);
        const counts = await countsOf(db);
        return {
          items: page.map(view),
          unread_count: counts.unread,
          action_required_count: counts.action_required,
          ...(rows.length > size && last ? { next_cursor: encodeCursor(last) } : {}),
        };
      });
    },

    counts: (p) => asApp(pool, p, countsOf),

    async get(p, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const row = await one(db, id);
        if (!row) return null;
        await refreshAvailability(db, [row]);
        return view(row);
      });
    },

    async readAll(p) {
      await asApp(pool, p, (db) =>
        db.query(
          "update notify.notification set read_at = now() where read_at is null and archived_at is null",
        ),
      );
    },

    async patch(p, id, patch) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const { rowCount } = await db.query(
          `update notify.notification
              set read_at = case when $2::boolean is null then read_at
                                 when $2 then coalesce(read_at, now()) else null end,
                  archived_at = case when $3::boolean is null then archived_at
                                     when $3 then coalesce(archived_at, now()) else null end
            where id = $1`,
          [id, patch.read ?? null, patch.archived ?? null],
        );
        if (rowCount === 0) return null;
        const row = await one(db, id);
        if (!row) return null;
        await refreshAvailability(db, [row]);
        return view(row);
      });
    },

    async act(p, id, body, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      if (JSON.stringify(body.payload ?? {}).length > MAX_PAYLOAD_CHARS) {
        return refused(400, "INVALID_REQUEST", "That action's details are too large.");
      }
      const row = await asApp(pool, p, async (db) => {
        const found = await one(db, id);
        if (found) await refreshAvailability(db, [found]);
        return found;
      });
      if (!row) return { ok: false, reason: "NOT_FOUND" };
      // An item that is finished, put away or whose object is gone can't be acted on.
      if (row.done_at) return refused(409, "ALREADY_DONE", "That's already been dealt with.");
      if (row.archived_at) return refused(409, "ARCHIVED", "That notification is archived.");
      if (!row.available) {
        return refused(409, "UNAVAILABLE", "That item is no longer available to you.");
      }
      const offered = (row.actions ?? []).some((a) => a.id === body.action);
      if (!offered) return { ok: false, reason: "UNKNOWN_ACTION" };
      let result: NotificationActResult;
      if (body.action === "open") {
        result = { result: "redirect", url: isRelativeLink(row.url) ? row.url : "#/" };
      } else {
        const handler = actions.find(row.kind, body.action);
        if (!handler) return { ok: false, reason: "NO_HANDLER" };
        try {
          result = await handler(
            p,
            {
              id: row.id,
              kind: row.kind,
              objectType: row.object_type,
              objectId: row.object_id,
              url: row.url,
            },
            body.payload ?? {},
            client,
          );
        } catch (err) {
          if (err instanceof ActionRefused) {
            return {
              ok: false,
              reason: "REFUSED",
              status: err.status,
              code: err.code,
              message: err.message,
            };
          }
          throw err;
        }
      }
      // Whatever a handler returns, a redirect never leaves the app.
      if (result.result === "redirect" && !(result.url && isRelativeLink(result.url))) {
        result = { result: "redirect", url: isRelativeLink(row.url) ? row.url : "#/" };
      }
      const notification = await asApp(pool, p, async (db) => {
        await db.query(
          `update notify.notification
              set read_at = coalesce(read_at, now()),
                  done_at = case when $2 then coalesce(done_at, now()) else done_at end
            where id = $1`,
          [id, result.result === "done"],
        );
        const fresh = await one(db, id);
        return fresh ? view(fresh) : view(row);
      });
      return { ok: true, result, notification };
    },

    async changes(p, since) {
      return asApp(pool, p, async (db) => {
        // A stream must not outlive the session or the person's account.
        const alive = (
          await db.query<{ ok: boolean }>(
            `select exists (select 1 from core."user" where id = core.current_user_id()
                              and status = 'active')
                    and ($1::text = '' or exists (select 1 from core.session
                          where id = $1::uuid and revoked_at is null and expires_at > now())) as ok`,
            [p.sessionId],
          )
        ).rows[0]?.ok;
        if (!alive) throw new Error("SESSION_ENDED");
        const clock = (await db.query<{ now: string }>("select clock_timestamp()::text as now"))
          .rows[0]?.now as string;
        const counts = await countsOf(db);
        if (since === null) return { items: [], marks: [], counts, high: clock };
        const { rows } = await db.query<Row & { micros: string }>(
          `select ${COLUMNS}, (extract(epoch from n.created_at) * 1000000)::bigint::text as micros
             ${FROM}
            where n.archived_at is null and n.created_at > $1::timestamptz - interval '5 seconds'
            order by n.created_at, n.id limit 100`,
          [since],
        );
        await refreshAvailability(db, rows);
        return {
          items: rows.map(view),
          marks: rows.map((r) => BigInt(r.micros)),
          counts,
          high: clock,
        };
      });
    },

    settings: (p) => asApp(pool, p, settingsOf),

    async patchSettings(p, patch, client) {
      if (patch.quiet_hours && !validZone(patch.quiet_hours.tz)) {
        return { ok: false, reason: "INVALID_TZ" };
      }
      return asApp(pool, p, async (db) => {
        for (const c of patch.categories ?? []) {
          await db.query(
            `insert into notify.notification_pref (workspace_id, user_id, category, value, mode)
             values ($1, $2, $3, $4, coalesce($5::text, 'action_only'))
             on conflict (user_id, category) do update
               set value = excluded.value, mode = coalesce($5::text, notify.notification_pref.mode),
                   updated_at = now()`,
            [p.workspaceId, p.userId, c.category, c.value, c.mode ?? null],
          );
        }
        if (patch.quiet_hours === null) {
          await db.query("delete from notify.notification_quiet_hours");
        } else if (patch.quiet_hours) {
          const q = patch.quiet_hours;
          await db.query(
            `insert into notify.notification_quiet_hours (workspace_id, user_id, from_local, to_local, tz)
             values ($1, $2, $3, $4, $5)
             on conflict (user_id) do update
               set from_local = excluded.from_local, to_local = excluded.to_local,
                   tz = excluded.tz, updated_at = now()`,
            [p.workspaceId, p.userId, q.from, q.to, q.tz],
          );
        }
        await audit(db, p, client, "notification_settings.updated", "user", p.userId, {
          categories: (patch.categories ?? []).map((c) => c.category),
          quiet_hours:
            patch.quiet_hours === undefined
              ? "unchanged"
              : patch.quiet_hours === null
                ? "cleared"
                : "set",
        });
        return { ok: true as const, settings: await settingsOf(db) };
      });
    },

    async adminSettings(p) {
      return asApp(pool, p, async (db) => ((await canConfigure(db)) ? adminOf(db) : null));
    },

    async patchAdminSettings(p, patch, client) {
      return asApp(pool, p, async (db) => {
        if (!(await canConfigure(db))) return null;
        const before = await adminOf(db);
        const changed: string[] = [];
        for (const c of patch.categories ?? []) {
          const was = before.categories.find((b) => b.category === c.category);
          const wants = {
            default: c.default ?? was?.default ?? true,
            locked: c.locked ?? was?.locked ?? false,
          };
          if (was && was.default === wants.default && was.locked === wants.locked) continue;
          await db.query(
            `insert into notify.workspace_notification_pref (workspace_id, category, default_value, locked)
             values ($1, $2, $3, $4)
             on conflict (workspace_id, category) do update
               set default_value = excluded.default_value, locked = excluded.locked, updated_at = now()`,
            [p.workspaceId, c.category, wants.default, wants.locked],
          );
          changed.push(c.category);
        }
        let contentChanged = false;
        if (
          patch.include_content !== undefined &&
          patch.include_content !== before.include_content
        ) {
          await db.query(
            `insert into notify.workspace_notification_setting (workspace_id, include_content)
             values ($1, $2)
             on conflict (workspace_id) do update
               set include_content = excluded.include_content, updated_at = now()`,
            [p.workspaceId, patch.include_content],
          );
          contentChanged = true;
        }
        if (changed.length > 0 || contentChanged) {
          await audit(
            db,
            p,
            client,
            "workspace_notification_settings.updated",
            "workspace",
            p.workspaceId,
            { categories: changed, include_content_changed: contentChanged },
          );
        }
        return adminOf(db);
      });
    },

    async purge() {
      return asWorker(pool, async (db) => {
        const { rows } = await db.query<{ archived: number; deleted: number }>(
          "select archived, deleted from notify.purge()",
        );
        return rows[0] ?? { archived: 0, deleted: 0 };
      });
    },
  };
}
