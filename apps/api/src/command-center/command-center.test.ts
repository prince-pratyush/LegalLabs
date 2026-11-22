import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth, type Principal } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp, asWorker } from "../db.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createAnalyticsJob } from "./job.js";
import {
  type Counter,
  recordOutcome,
  recordUsage,
  type Surface,
  type WorkflowType,
} from "./record.js";
import { createCommandCenter, EXPORT_COLUMNS, METHODOLOGY } from "./service.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "test" };
const DAY = 86_400_000;
const todayMs = Math.floor(Date.now() / DAY) * DAY;
const dayStr = (off: number) => new Date(todayMs - off * DAY).toISOString().slice(0, 10);
const noon = (off: number) => new Date(todayMs - off * DAY + 12 * 3_600_000);
const asPrincipal = (id: string, workspaceId: string): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: id,
  workspaceId,
});

// A small deterministic generator, so a failure can be reproduced.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Person {
  key: string;
  id: string;
  name: string;
  email: string;
  role: string;
  roleId: string;
  area: string;
  title: string;
  kind: "member" | "guest";
}

async function addRole(workspaceId: string, name: string, permissions: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [workspaceId, name, permissions],
  );
  return rows[0]?.id ?? "";
}

async function addUser(
  ws: Seeded,
  o: {
    key: string;
    name: string;
    roleId: string | null;
    roleName?: string;
    kind?: "member" | "guest";
    status?: string;
    area?: string;
    title?: string;
    password?: boolean;
    createdDaysAgo?: number;
  },
): Promise<Person> {
  const email = `${o.key}@${ws.slug}.test`;
  const profile: Record<string, string> = {};
  if (o.area !== undefined) profile.practice_area = o.area;
  if (o.title !== undefined) profile.title = o.title;
  const { rows } = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, name, role_id, status, kind, profile, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8)) returning id`,
    [
      ws.workspaceId,
      email,
      o.name,
      o.roleId,
      o.status ?? "active",
      o.kind ?? "member",
      JSON.stringify(profile),
      o.createdDaysAgo ?? 0,
    ],
  );
  const id = rows[0]?.id ?? "";
  if (o.kind === "guest") {
    // Without a profile a guest is locked out.
    await pool.query(
      `insert into core.guest_profile (workspace_id, user_id, email_domain, expires_at)
       values ($1, $2, 'example.test', now() + interval '365 days')`,
      [ws.workspaceId, id],
    );
  }
  if (o.password) {
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [ws.workspaceId, id, await hashPassword(PASSWORD)],
    );
  }
  return {
    key: o.key,
    id,
    name: o.name,
    email,
    role: o.roleName ?? "",
    roleId: o.roleId ?? "",
    area: o.area ?? "",
    title: o.title ?? "",
    kind: o.kind ?? "member",
  };
}

const materialise = () =>
  asWorker(pool, (db) => db.query("select analytics.materialise_all() as n"));

function harness(store = createMemoryStore(), gzipOverBytes?: number) {
  const center = createCommandCenter(pool, {
    store,
    ...(gzipOverBytes === undefined ? {} : { gzipOverBytes }),
  });
  const documents = testDocuments(pool);
  const base = testThreads(pool, documents);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: base,
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: { resolve: async () => null },
    }),
    commandCenter: center,
    clientIp: () => client.ip,
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const call = async (cookie: string, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    return res;
  };
  const json = async (res: Response) => {
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
    return (text ? JSON.parse(text) : null) as any;
  };
  return { center, store, app, signIn, call, json };
}

// ---------------------------------------------------------------------------------------------
// The gate: every chart equals what plain TypeScript computes from the raw events.
// ---------------------------------------------------------------------------------------------

interface Ev {
  key: string;
  off: number;
  surface: Surface;
  cls: "query" | "other";
  counter: Counter | null;
  src: 0 | 1 | 2;
}
interface Oc {
  key: string;
  off: number;
  type: WorkflowType;
  qty: number;
  turnaround: number | null;
}

const SURFACE_LIST: Surface[] = [
  "web",
  "word",
  "outlook",
  "review_tables",
  "agents",
  "apps",
  "email",
  "api",
  "mobile",
];
const COUNTER_LIST: (Counter | null)[] = [
  null,
  null,
  "threads",
  "follow_ups",
  "agent_runs",
  "playbook_runs",
  "rt_columns",
  "word",
  "outlook",
];
const BASELINE: Record<WorkflowType, number> = {
  contract_reviewed: 2,
  redline_applied: 1,
  table_exported: 0.1,
  draft_exported: 1.5,
  research_memo_completed: 4,
  request_resolved: 0.5,
  chronology_generated: 6,
  translation_completed: 1,
  proofread_applied: 0.5,
};
const TYPES = Object.keys(BASELINE) as WorkflowType[];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function mondayOf(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = d.getUTCDay() === 0 ? 6 : d.getUTCDay() - 1;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) / 2;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] ?? 0) + ((s[hi] ?? 0) - (s[lo] ?? 0)) * (pos - lo);
}

describe("charts match raw events", () => {
  it("every chart and table equals the figures computed from the raw events", async () => {
    const ws = await seedMember(pool);
    const reporter = asPrincipal(ws.userId, ws.workspaceId);
    const assocRole = await addRole(ws.workspaceId, "Associate", ["threads.use"]);
    const adminRole = (
      await pool.query<{ id: string }>('select role_id as id from core."user" where id = $1', [
        ws.userId,
      ])
    ).rows[0]?.id as string;
    await pool.query(
      `update core."user" set name = 'Ada Admin', profile = '{"practice_area":"Litigation","title":"Partner"}' where id = $1`,
      [ws.userId],
    );
    const people: Person[] = [
      {
        key: "ada",
        id: ws.userId,
        name: "Ada Admin",
        email: ws.email,
        role: "Admin",
        roleId: adminRole,
        area: "Litigation",
        title: "Partner",
        kind: "member",
      },
      await addUser(ws, {
        key: "ben",
        name: "Ben Ames",
        roleId: assocRole,
        roleName: "Associate",
        area: "Corporate",
        title: "Associate",
      }),
      await addUser(ws, {
        key: "cho",
        name: "Cho Lee",
        roleId: assocRole,
        roleName: "Associate",
        area: "Litigation",
        title: "Associate",
      }),
      await addUser(ws, {
        key: "dee",
        name: "Dee Fox",
        roleId: assocRole,
        roleName: "Associate",
        area: "",
        title: "Paralegal",
      }),
      await addUser(ws, {
        key: "eli",
        name: "Eli Roe",
        roleId: adminRole,
        roleName: "Admin",
        area: "Corporate",
        title: "Partner",
      }),
      await addUser(ws, {
        key: "fay",
        name: "Fay Gill",
        roleId: assocRole,
        roleName: "Associate",
        area: "Tax",
        title: "Counsel",
      }),
      await addUser(ws, {
        key: "gus",
        name: "Gus Guest",
        roleId: null,
        kind: "guest",
        area: "Corporate",
        title: "Client",
      }),
    ];
    const by = new Map(people.map((p) => [p.key, p]));
    const plan: [string, number, number, number][] = [
      // key, events, first day offset, last day offset
      ["ada", 60, 1, 60],
      ["ben", 70, 1, 60],
      ["cho", 50, 1, 60],
      ["dee", 30, 1, 60],
      ["eli", 40, 1, 60],
      ["fay", 30, 20, 60],
      ["gus", 20, 1, 60],
    ];
    const rand = rng(20260801);
    const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)] as T;
    const events: Ev[] = [];
    for (const [key, n, lo, hi] of plan) {
      for (let i = 0; i < n; i++) {
        events.push({
          key,
          off: lo + Math.floor(rand() * (hi - lo + 1)),
          surface: pick(SURFACE_LIST),
          cls: rand() < 0.8 ? "query" : "other",
          counter: pick(COUNTER_LIST),
          src: pick([0, 0, 1, 2] as const),
        });
      }
    }
    const outcomes: Oc[] = [];
    for (const key of ["ada", "ben", "cho", "eli", "gus"]) {
      for (let i = 0; i < 14; i++) {
        const type = pick(TYPES);
        outcomes.push({
          key,
          off: 1 + Math.floor(rand() * 60),
          type,
          qty: type === "table_exported" ? 20 + Math.floor(rand() * 600) : 1,
          turnaround: rand() < 0.85 ? 30 + Math.floor(rand() * 5000) : null,
        });
      }
    }

    for (const p of people) {
      await asApp(pool, asPrincipal(p.id, ws.workspaceId), async (db) => {
        for (const e of events.filter((x) => x.key === p.key)) {
          await recordUsage(db, {
            surface: e.surface,
            action: "test.event",
            actionClass: e.cls,
            ...(e.counter ? { counter: e.counter } : {}),
            sourceKinds: e.src === 1 ? ["vault"] : [],
            documentCount: e.src === 2 ? 1 : 0,
            at: noon(e.off),
          });
        }
        for (const o of outcomes.filter((x) => x.key === p.key)) {
          await recordOutcome(db, {
            workflowType: o.type,
            quantity: o.qty,
            ...(o.turnaround === null ? {} : { turnaroundSeconds: o.turnaround }),
            at: noon(o.off),
          });
        }
      });
    }
    // Citations: a thread with a few assistant messages on known days, one checked citation each.
    const doc = (
      await pool.query<{ id: string }>(
        "insert into content.document (workspace_id, owner_id, name, mime, size) values ($1, $2, 'a.pdf', 'application/pdf', 10) returning id",
        [ws.workspaceId, ws.userId],
      )
    ).rows[0]?.id;
    const version = (
      await pool.query<{ id: string }>(
        `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
         values ($1, $2, decode(repeat('ab', 32), 'hex'), 1, $3) returning id`,
        [ws.workspaceId, doc, ws.userId],
      )
    ).rows[0]?.id;
    const thread = (
      await pool.query<{ id: string }>(
        "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 't') returning id",
        [ws.workspaceId, ws.userId],
      )
    ).rows[0]?.id;
    const cites: { off: number; status: "ok" | "mismatch" | "unresolved"; n: number }[] = [
      { off: 3, status: "ok", n: 3 },
      { off: 3, status: "mismatch", n: 1 },
      { off: 10, status: "ok", n: 2 },
      { off: 10, status: "unresolved", n: 2 },
      { off: 70, status: "ok", n: 5 },
    ];
    for (const [i, c] of cites.entries()) {
      const msg = (
        await pool.query<{ id: string }>(
          `insert into work.message (workspace_id, thread_id, role, content, created_at)
           values ($1, $2, 'assistant', 'x', $3) returning id`,
          [ws.workspaceId, thread, noon(c.off)],
        )
      ).rows[0]?.id;
      for (let k = 0; k < c.n; k++) {
        await pool.query(
          `insert into work.citation (message_id, ordinal, workspace_id, anchor, version_id, page_no, quote, char_from, char_to, status)
           values ($1, $2, $3, 0, $4, 1, 'q', 0, 1, $5)`,
          [msg, k, ws.workspaceId, c.status === "ok" ? version : null, c.status],
        );
      }
      void i;
    }
    // The former member is deprovisioned after the fact: history stays.
    await pool.query(`update core."user" set status = 'deprovisioned' where id = $1`, [
      by.get("fay")?.id,
    ]);

    await materialise();

    const center = createCommandCenter(pool, { store: createMemoryStore() });
    const range = { from: dayStr(59), to: dayStr(0) };
    const days = Array.from({ length: 60 }, (_, i) => 59 - i); // offsets, oldest first
    const isMember = (key: string) => by.get(key)?.kind === "member";
    const q = events.filter((e) => e.cls === "query" && isMember(e.key));
    const activeOn = (off: number) => new Set(q.filter((e) => e.off === off).map((e) => e.key));
    const mauOn = (off: number) => {
      const s = new Set<string>();
      for (let o = off; o <= off + 29; o++) for (const k of activeOn(o)) s.add(k);
      return s;
    };

    const overview = await center.overview(reporter, { range, grouping: "day" });
    expect(overview.state).toBe("ready");
    expect(overview.dataAsOf).not.toBeNull();

    // 1. Monthly users returning daily: mean of the day's DAU/MAU, as a percentage.
    const ratios = new Map<string, number[]>();
    for (const off of days) {
      const mau = mauOn(off).size;
      const ratio = mau === 0 ? 0 : Math.round((activeOn(off).size / mau) * 1e6) / 1e6;
      const month = dayStr(off).slice(0, 7);
      ratios.set(month, [...(ratios.get(month) ?? []), ratio]);
    }
    const monthly = [...ratios.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, r]) => ({
        month,
        days: r.length,
        percent: r2((r.reduce((a, b) => a + b, 0) / r.length) * 100),
      }));
    expect(overview.monthlyUsersReturningDaily.map((m) => [m.month, m.days])).toEqual(
      monthly.map((m) => [m.month, m.days]),
    );
    overview.monthlyUsersReturningDaily.forEach((m, i) => {
      expect(m.percent).toBeCloseTo(monthly[i]?.percent ?? -1, 2);
    });

    // 2. Product usage by surface.
    const everyone = new Set(q.map((e) => e.key));
    expect(overview.productUsageBySurface.activeUsers).toBe(everyone.size);
    for (const s of SURFACE_LIST) {
      const users = new Set(q.filter((e) => e.surface === s).map((e) => e.key)).size;
      const row = overview.productUsageBySurface.surfaces.find((x) => x.surface === s);
      expect(row?.users).toBe(users);
      expect(row?.share).toBeCloseTo(r2((users / everyone.size) * 100), 2);
    }

    // 3. Total active users per day, ISO week and month.
    expect(overview.totalActiveUsers.series).toEqual(
      days.map((off) => ({ bucket: dayStr(off), users: activeOn(off).size })),
    );
    for (const grouping of ["week", "month"] as const) {
      const buckets = new Map<string, Set<string>>();
      for (const off of days) {
        const d = dayStr(off);
        const key = grouping === "week" ? mondayOf(d) : d.slice(0, 7);
        const set = buckets.get(key) ?? new Set<string>();
        for (const k of activeOn(off)) set.add(k);
        buckets.set(key, set);
      }
      const got = await center.overview(reporter, { range, grouping });
      expect(got.totalActiveUsers.series).toEqual(
        [...buckets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([bucket, s]) => ({ bucket, users: s.size })),
      );
    }

    // 4. Top power users.
    const inRange = events.filter((e) => isMember(e.key) && e.off <= 59);
    const power = [...everyone]
      .map((key) => {
        const mine = inRange.filter((e) => e.key === key);
        const activeDays = new Set(mine.filter((e) => e.cls === "query").map((e) => e.off));
        const surfaces: Record<string, number> = {};
        for (const s of SURFACE_LIST) {
          const n = new Set(
            mine.filter((e) => e.cls === "query" && e.surface === s).map((e) => e.off),
          ).size;
          if (n > 0) surfaces[s] = n;
        }
        return {
          email: by.get(key)?.email ?? "",
          active_days: activeDays.size,
          total_activity: mine.filter((e) => e.counter !== null).length,
          surfaces,
        };
      })
      .sort(
        (a, b) =>
          b.active_days - a.active_days ||
          b.total_activity - a.total_activity ||
          a.email.localeCompare(b.email),
      )
      .slice(0, 10);
    expect(
      overview.topPowerUsers.map((u) => ({
        email: u.email,
        active_days: u.active_days,
        total_activity: u.total_activity,
        surfaces: u.surfaces,
      })),
    ).toEqual(power);
    expect(overview.topPowerUsers.every((u) => u.name.length > 0)).toBe(true);

    // 5. Queries over time with and without sources, daily and weekly.
    const analytics = await center.analytics(reporter, { range, granularity: "day" });
    const withSrc = (e: Ev) => e.src !== 0;
    expect(analytics.queriesOverTime.series).toEqual(
      days.map((off) => ({
        bucket: dayStr(off),
        with_sources: q.filter((e) => e.off === off && withSrc(e)).length,
        without_sources: q.filter((e) => e.off === off && !withSrc(e)).length,
      })),
    );
    const weekly = await center.analytics(reporter, { range, granularity: "week" });
    const wk = new Map<string, { with_sources: number; without_sources: number }>();
    for (const off of days) {
      const key = mondayOf(dayStr(off));
      const cur = wk.get(key) ?? { with_sources: 0, without_sources: 0 };
      cur.with_sources += q.filter((e) => e.off === off && withSrc(e)).length;
      cur.without_sources += q.filter((e) => e.off === off && !withSrc(e)).length;
      wk.set(key, cur);
    }
    expect(weekly.queriesOverTime.series).toEqual(
      [...wk.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, v]) => ({ bucket, ...v })),
    );

    // 6. Practice areas and job titles ("Unknown" for empty).
    const buckets = (field: "area" | "title") => {
      const out = new Map<string, { users: Set<string>; queries: number }>();
      for (const e of q.filter((x) => x.off <= 59)) {
        const label = by.get(e.key)?.[field] || "Unknown";
        const cur = out.get(label) ?? { users: new Set<string>(), queries: 0 };
        cur.users.add(e.key);
        cur.queries += 1;
        out.set(label, cur);
      }
      return [...out.entries()]
        .map(([label, v]) => ({ label, users: v.users.size, queries: v.queries }))
        .sort(
          (a, b) => b.users - a.users || b.queries - a.queries || a.label.localeCompare(b.label),
        );
    };
    expect(analytics.topPracticeAreas).toEqual(buckets("area"));
    expect(analytics.topJobTitles).toEqual(buckets("title"));
    expect(analytics.topPracticeAreas.some((a) => a.label === "Unknown")).toBe(true);

    // 7. Users by activity: all columns, default sort, search, sort and pages.
    const expectedUsers = [...new Set(inRange.map((e) => e.key))].map((key) => {
      const mine = inRange.filter((e) => e.key === key);
      const count = (c: Counter) => mine.filter((e) => e.counter === c).length;
      const queryDays = mine.filter((e) => e.cls === "query").map((e) => e.off);
      return {
        name: by.get(key)?.name ?? "",
        email: by.get(key)?.email ?? "",
        role: by.get(key)?.role ?? "",
        active_days: new Set(queryDays).size,
        total_activity: mine.filter((e) => e.counter !== null).length,
        threads: count("threads"),
        follow_ups: count("follow_ups"),
        agent_runs: count("agent_runs"),
        playbook_runs: count("playbook_runs"),
        rt_columns: count("rt_columns"),
        word: count("word"),
        outlook: count("outlook"),
        last_active: queryDays.length ? dayStr(Math.min(...queryDays)) : null,
      };
    });
    const shape = <T extends { user_id: string; status: string }>(r: T) => {
      const { user_id: _u, status: _s, ...rest } = r;
      return rest;
    };
    const table = await center.usersByActivity(reporter, { range, pageSize: 200 });
    expect(table.total).toBe(expectedUsers.length);
    expect(table.rows.map(shape)).toEqual(
      [...expectedUsers].sort(
        (a, b) => b.active_days - a.active_days || a.email.localeCompare(b.email),
      ),
    );
    const byThreads = await center.usersByActivity(reporter, {
      range,
      sort: "threads",
      dir: "desc",
      pageSize: 2,
      page: 2,
    });
    const sortedThreads = [...expectedUsers].sort(
      (a, b) => b.threads - a.threads || a.email.localeCompare(b.email),
    );
    expect(byThreads.rows.map((r) => r.email)).toEqual(
      sortedThreads.slice(2, 4).map((r) => r.email),
    );
    const found = await center.usersByActivity(reporter, { range, q: "CHO LEE" });
    expect(found.rows.map((r) => r.name)).toEqual(["Cho Lee"]);
    // Filters: role and practice area narrow the table.
    const corporate = await center.usersByActivity(reporter, {
      range,
      filters: { practiceAreas: ["Corporate"] },
    });
    expect(corporate.rows.map((r) => r.name).sort()).toEqual(["Ben Ames", "Eli Roe"]);
    const assoc = await center.usersByActivity(reporter, {
      range,
      filters: { roles: [assocRole] },
    });
    expect(assoc.rows.map((r) => r.role)).toEqual(Array(assoc.total).fill("Associate"));
    // The guest never shows in any chart or table.
    expect(table.rows.some((r) => r.name === "Gus Guest")).toBe(false);
    expect(JSON.stringify(overview)).not.toContain(by.get("gus")?.id ?? "x");

    // Guest activity is counted apart, never charted.
    const guestQueries = events.filter((e) => e.key === "gus" && e.cls === "query").length;
    const g = await pool.query<{ n: string }>(
      "select coalesce(sum((metrics ->> 'guest_activity')::int), 0) as n from analytics.daily where workspace_id = $1",
      [ws.workspaceId],
    );
    expect(Number(g.rows[0]?.n)).toBe(guestQueries);

    // 8. Outcomes: hours saved, counts, medians per workflow type, citations.
    const oc = outcomes.filter((o) => isMember(o.key) && o.off <= 59);
    const saved = (o: Oc) =>
      o.type === "table_exported" ? Math.min(r2(BASELINE[o.type] * o.qty), 40) : BASELINE[o.type];
    const got = await center.outcomes(reporter, { range });
    expect(got.methodology).toBe(METHODOLOGY);
    expect(got.hoursSaved).toBeCloseTo(r2(oc.reduce((s, o) => s + saved(o), 0)), 2);
    expect(got.contractsReviewed).toBe(oc.filter((o) => o.type === "contract_reviewed").length);
    expect(got.requestsResolved).toBe(oc.filter((o) => o.type === "request_resolved").length);
    for (const type of TYPES) {
      const mine = oc.filter((o) => o.type === type);
      const row = got.workflows.find((w) => w.workflow_type === type);
      if (mine.length === 0) {
        expect(row).toBeUndefined();
        continue;
      }
      expect(row?.count).toBe(mine.length);
      expect(row?.hours_saved).toBeCloseTo(r2(mine.reduce((s, o) => s + saved(o), 0)), 2);
      // The range median is the completion-weighted median of each day's own median.
      const perDay = new Map<number, Oc[]>();
      for (const o of mine) perDay.set(o.off, [...(perDay.get(o.off) ?? []), o]);
      const items = [...perDay.values()]
        .map((list) => {
          const t = list.flatMap((o) => (o.turnaround === null ? [] : [o.turnaround]));
          return { value: t.length ? median(t) : null, weight: list.length };
        })
        .flatMap((i) => (i.value === null ? [] : [{ value: i.value, weight: i.weight }]))
        .sort((a, b) => a.value - b.value);
      const total = items.reduce((s, i) => s + i.weight, 0);
      let seen = 0;
      let want: number | null = null;
      for (const i of items) {
        seen += i.weight;
        if (seen * 2 >= total) {
          want = i.value;
          break;
        }
      }
      expect(row?.turnaround_p50_seconds ?? null).toBeCloseTo(want ?? Number.NaN, 5);
    }
    const okCount = cites
      .filter((c) => c.off <= 59 && c.status === "ok")
      .reduce((s, c) => s + c.n, 0);
    const flagged = cites
      .filter((c) => c.off <= 59 && c.status !== "ok")
      .reduce((s, c) => s + c.n, 0);
    expect(got.citations).toEqual({
      verified: okCount,
      flagged,
      rate: Math.round((okCount / (okCount + flagged)) * 1e4) / 1e4,
    });

    // 9. CSVs: the same numbers; the outcomes file prints the methodology.
    const usersCsv = await center.csv(reporter, "users", { range });
    const lines = usersCsv.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "name,email,role,active_days,total_activity,threads,follow_ups,agent_runs,playbook_runs,rt_columns,word,outlook,last_active",
    );
    expect(lines.length - 1).toBe(expectedUsers.length);
    const outcomesCsv = await center.csv(reporter, "outcomes", { range });
    expect(outcomesCsv.text).toContain(METHODOLOGY);
    const surfaceCsv = await center.csv(reporter, "surface_usage", { range });
    expect(surfaceCsv.text.split("\r\n")[0]).toBe("surface,active_users,share_percent");
    for (const chart of [
      "monthly_returning",
      "active_users",
      "power_users",
      "queries_over_time",
      "practice_areas",
      "job_titles",
    ] as const) {
      const f = await center.csv(reporter, chart, { range });
      expect(f.text.length).toBeGreaterThan(10);
      expect(f.filename).toContain(range.from);
    }

    // 10. The event export has one row per raw event in range (guest and former included).
    const store = createMemoryStore();
    const exporter = createCommandCenter(pool, { store });
    const job = await exporter.createExport(
      reporter,
      { range: { from: dayStr(40), to: dayStr(0) } },
      client,
    );
    const wantRows = events.filter((e) => e.off <= 40).length;
    expect(job.status).toBe("done");
    expect(job.row_count).toBe(wantRows);
    const file = await exporter.downloadExport(reporter, job.id);
    const text = Buffer.from(file.bytes).toString("utf8");
    const exportLines = text.trim().split("\r\n");
    expect(exportLines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(EXPORT_COLUMNS).toHaveLength(21);
    expect(exportLines.length - 1).toBe(wantRows);
    expect(exportLines.some((l) => l.includes(",guest,"))).toBe(true);
    expect(exportLines.some((l) => l.includes(",former,"))).toBe(true);
    for (const banned of ["prompt", "content", "file_name", "quote", "text"]) {
      expect(EXPORT_COLUMNS.some((c) => c.includes(banned))).toBe(false);
    }
    const trail = await auditTrail(pool, ws.workspaceId);
    expect(trail.filter((a) => a.action === "analytics.export_created")).toHaveLength(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------

describe("materialisation", () => {
  it("a late event re-materialises its day", async () => {
    const ws = await seedMember(pool);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    const ben = await addUser(ws, { key: "ben", name: "Ben", roleId: null });
    await asApp(pool, p, (db) =>
      recordUsage(db, {
        surface: "web",
        action: "thread.message_sent",
        actionClass: "query",
        at: noon(3),
      }),
    );
    await materialise();
    const center = createCommandCenter(pool, { store: createMemoryStore() });
    const range = { from: dayStr(5), to: dayStr(0) };
    const before = await center.overview(p, { range });
    expect(before.totalActiveUsers.series.find((s) => s.bucket === dayStr(3))?.users).toBe(1);
    await asApp(pool, asPrincipal(ben.id, ws.workspaceId), (db) =>
      recordUsage(db, { surface: "word", action: "word.ask", actionClass: "query", at: noon(3) }),
    );
    // Not yet visible: charts only read what was materialised.
    const stale = await center.overview(p, { range });
    expect(stale.totalActiveUsers.series.find((s) => s.bucket === dayStr(3))?.users).toBe(1);
    await materialise();
    const after = await center.overview(p, { range });
    expect(after.totalActiveUsers.series.find((s) => s.bucket === dayStr(3))?.users).toBe(2);
  });

  it("shows a first-refresh state before anything is materialised", async () => {
    const ws = await seedMember(pool);
    const center = createCommandCenter(pool, { store: createMemoryStore() });
    const view = await center.overview(asPrincipal(ws.userId, ws.workspaceId), {});
    expect(view.dataAsOf).toBeNull();
    expect(view.state).toBe("no_materialisation_yet");
    expect(view.message).toMatch(/^First refresh at \d{4}-\d{2}-\d{2}T(00|06|12|18):00:00/);
    expect(view.totalActiveUsers.series).toEqual([]);
    const actions = await center.recommendedActions(asPrincipal(ws.userId, ws.workspaceId));
    expect(actions.map((a) => a.key)).toContain("no_materialisation");
  });

  it("the job materialises every workspace and clears expired exports", async () => {
    const ws = await seedMember(pool);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    await asApp(pool, p, (db) =>
      recordUsage(db, {
        surface: "web",
        action: "thread.message_sent",
        actionClass: "query",
        at: noon(2),
      }),
    );
    const store = createMemoryStore();
    const center = createCommandCenter(pool, { store });
    const exported = await center.createExport(
      p,
      { range: { from: dayStr(5), to: dayStr(0) } },
      client,
    );
    const key = (
      await pool.query<{ storage_key: string }>(
        "select storage_key from analytics.export_job where id = $1",
        [exported.id],
      )
    ).rows[0]?.storage_key as string;
    expect(await store.get(key)).not.toBeNull();
    // Past its seven days: the link is gone at once, and the next pass removes the file.
    await pool.query(
      "update analytics.export_job set expires_at = now() - interval '1 minute' where id = $1",
      [exported.id],
    );
    await expect(center.downloadExport(p, exported.id)).rejects.toMatchObject({ status: 404 });
    const job = createAnalyticsJob(pool, { store });
    const result = await job.runOnce();
    expect(result.expiredExports).toBeGreaterThanOrEqual(1);
    expect(await store.get(key)).toBeNull();
    const left = await pool.query("select 1 from analytics.export_job where id = $1", [
      exported.id,
    ]);
    expect(left.rowCount).toBe(0);
    const view = await center.overview(p, { range: { from: dayStr(5), to: dayStr(0) } });
    expect(view.state).toBe("ready");
    expect(view.totalActiveUsers.series.find((s) => s.bucket === dayStr(2))?.users).toBe(1);
  });
});

describe("access", () => {
  it("only admin.reporting reads; everyone else gets 403 and RLS hides the tables", async () => {
    const ws = await seedMember(pool);
    const role = await addRole(ws.workspaceId, "Associate", ["threads.use"]);
    const ben = await addUser(ws, { key: "ben", name: "Ben", roleId: role, password: true });
    const boss = asPrincipal(ws.userId, ws.workspaceId);
    const plain = asPrincipal(ben.id, ws.workspaceId);
    await asApp(pool, plain, (db) =>
      recordUsage(db, {
        surface: "web",
        action: "thread.message_sent",
        actionClass: "query",
        at: noon(2),
      }),
    );
    await materialise();
    const h = harness();
    const cookie = await h.signIn({ slug: ws.slug, email: ben.email });
    for (const path of [
      "/admin/analytics/overview",
      "/admin/analytics/report",
      "/admin/analytics/users",
      "/admin/analytics/outcomes",
      "/admin/analytics/baselines",
      "/admin/analytics/actions",
      "/admin/analytics/exports",
      "/admin/analytics/csv?chart=users",
    ]) {
      const res = await h.call(cookie, "GET", path);
      expect(res.status, path).toBe(403);
      expect(await h.json(res)).toMatchObject({ code: "FORBIDDEN" });
    }
    for (const [method, path, body] of [
      ["POST", "/admin/analytics/refresh", undefined],
      ["POST", "/admin/analytics/exports", { from: dayStr(5), to: dayStr(0) }],
      ["PUT", "/admin/analytics/baselines/contract_reviewed", { hours: 3 }],
    ] as const) {
      const res = await h.call(cookie, method, path, body);
      expect(res.status, path).toBe(403);
    }
    // Direct reads as that person see nothing; as the admin they see rows.
    for (const table of ["usage_event", "daily", "outcome_event", "refresh_state", "export_job"]) {
      const mine = await asApp(pool, plain, (db) => db.query(`select 1 from analytics.${table}`));
      expect(mine.rowCount, table).toBe(0);
    }
    const adminSees = await asApp(pool, boss, (db) => db.query("select 1 from analytics.daily"));
    expect(adminSees.rowCount).toBeGreaterThan(0);
    // And a signed-out caller is refused before reaching the module.
    const anon = await h.app.request("/api/v1/admin/analytics/overview");
    expect(anon.status).toBe(401);
  });

  it("refresh is allowed once an hour and then returns 429", async () => {
    const ws = await seedMember(pool);
    const h = harness();
    const cookie = await h.signIn(ws);
    const first = await h.call(cookie, "POST", "/admin/analytics/refresh");
    expect(first.status).toBe(200);
    const second = await h.call(cookie, "POST", "/admin/analytics/refresh");
    expect(second.status).toBe(429);
    expect(await h.json(second)).toMatchObject({ code: "REFRESH_TOO_SOON" });
    const view = await h.json(await h.call(cookie, "GET", "/admin/analytics/overview"));
    expect(view.state).toBe("ready");
  });
});

describe("baselines and outcomes", () => {
  it("a baseline change is audited and history keeps the old baseline", async () => {
    const ws = await seedMember(pool);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    const reporterOnly = await addRole(ws.workspaceId, "Reporter", ["admin.reporting"]);
    const rep = await addUser(ws, {
      key: "rep",
      name: "Rep",
      roleId: reporterOnly,
      password: true,
    });
    const center = createCommandCenter(pool, { store: createMemoryStore() });

    const before = await center.baselines(p);
    expect(before).toHaveLength(9);
    expect(before.find((b) => b.workflow_type === "contract_reviewed")).toMatchObject({
      hours_per_completion: 2,
      is_default: true,
    });
    expect(before.find((b) => b.workflow_type === "table_exported")?.cap_hours).toBe(40);

    await asApp(pool, p, (db) =>
      recordOutcome(db, { workflowType: "contract_reviewed", at: noon(5) }),
    );
    const after = await center.setBaseline(
      p,
      "contract_reviewed",
      { hours: 3.5, note: "Our own time study" },
      client,
    );
    expect(after.find((b) => b.workflow_type === "contract_reviewed")).toMatchObject({
      hours_per_completion: 3.5,
      is_default: false,
      note: "Our own time study",
    });
    await asApp(pool, p, (db) =>
      recordOutcome(db, { workflowType: "contract_reviewed", at: noon(1) }),
    );

    const events = await pool.query<{ baseline_hours: string; hours_saved: string }>(
      "select baseline_hours, hours_saved from analytics.outcome_event where workspace_id = $1 order by at",
      [ws.workspaceId],
    );
    expect(events.rows.map((r) => [Number(r.baseline_hours), Number(r.hours_saved)])).toEqual([
      [2, 2],
      [3.5, 3.5],
    ]);
    await materialise();
    const range = { from: dayStr(10), to: dayStr(0) };
    expect((await center.outcomes(p, { range })).hoursSaved).toBe(5.5);

    const trail = (await auditTrail(pool, ws.workspaceId)).filter(
      (a) => a.action === "analytics.baseline_changed",
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      actor_id: ws.userId,
      object_type: "analytics_baseline",
      object_id: "contract_reviewed",
      details: { workflow_type: "contract_reviewed", previous_hours: 2, hours_per_completion: 3.5 },
    });
    expect(JSON.stringify(trail[0]?.details)).not.toContain("time study");

    // Reporting alone is not enough to edit them.
    await expect(
      center.setBaseline(
        asPrincipal(rep.id, ws.workspaceId),
        "contract_reviewed",
        { hours: 9 },
        client,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(center.baselines(asPrincipal(rep.id, ws.workspaceId))).resolves.toHaveLength(9);
  });

  it("a table export saves 0.1 hours a row, at most 40 hours", async () => {
    const ws = await seedMember(pool);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    await asApp(pool, p, async (db) => {
      await recordOutcome(db, { workflowType: "table_exported", quantity: 25, at: noon(2) });
      await recordOutcome(db, { workflowType: "table_exported", quantity: 5000, at: noon(2) });
    });
    await materialise();
    const center = createCommandCenter(pool, { store: createMemoryStore() });
    const got = await center.outcomes(p, { range: { from: dayStr(5), to: dayStr(0) } });
    expect(got.workflows.find((w) => w.workflow_type === "table_exported")).toMatchObject({
      count: 2,
      hours_saved: 42.5,
    });
    const rows = await pool.query<{ hours_saved: string }>(
      "select hours_saved from analytics.outcome_event where workspace_id = $1 order by hours_saved",
      [ws.workspaceId],
    );
    expect(rows.rows.map((r) => Number(r.hours_saved))).toEqual([2.5, 40]);
  });
});

describe("recommended actions", () => {
  it("flags invited users who never signed in and stays dismissed for 30 days", async () => {
    const ws = await seedMember(pool);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    await addUser(ws, {
      key: "old1",
      name: "Old One",
      roleId: null,
      status: "invited",
      createdDaysAgo: 45,
    });
    await addUser(ws, {
      key: "old2",
      name: "Old Two",
      roleId: null,
      status: "invited",
      createdDaysAgo: 31,
    });
    await addUser(ws, {
      key: "new1",
      name: "New One",
      roleId: null,
      status: "invited",
      createdDaysAgo: 3,
    });
    await addUser(ws, {
      key: "gone",
      name: "Gone",
      roleId: null,
      status: "deprovisioned",
      createdDaysAgo: 90,
    });
    await materialise();
    const center = createCommandCenter(pool, { store: createMemoryStore() });
    const actions = await center.recommendedActions(p);
    expect(actions).toEqual([
      expect.objectContaining({
        key: "invited_not_signed_in",
        title: "2 invited users have not signed in for 30 days",
      }),
    ]);
    await center.dismissAction(p, "invited_not_signed_in");
    expect(await center.recommendedActions(p)).toEqual([]);
    const row = await pool.query<{ days: string }>(
      "select extract(day from dismissed_until - now()) as days from analytics.action_dismissal where user_id = $1",
      [ws.userId],
    );
    expect(Number(row.rows[0]?.days)).toBeGreaterThanOrEqual(29);
    await expect(center.dismissAction(p, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("event export", () => {
  it("writes the 21 columns, honours filters, and gzips big files", async () => {
    const ws = await seedMember(pool);
    const role = await addRole(ws.workspaceId, "Associate", ["threads.use"]);
    const ben = await addUser(ws, { key: "ben", name: "Ben", roleId: role, roleName: "Associate" });
    const gone = await addUser(ws, { key: "gone", name: "Gone", roleId: role });
    const group = (
      await pool.query<{ id: string }>(
        "insert into core.\"group\" (workspace_id, name) values ($1, 'Lit team') returning id",
        [ws.workspaceId],
      )
    ).rows[0]?.id;
    await pool.query(
      "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
      [ws.workspaceId, group, ben.id],
    );
    await asApp(pool, asPrincipal(ben.id, ws.workspaceId), async (db) => {
      await recordUsage(db, {
        surface: "web",
        action: "thread.message_sent",
        actionClass: "query",
        counter: "threads",
        sourceKinds: ["vault", "knowledge"],
        documentCount: 2,
        model: "m-1",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.0123,
        durationMs: 900,
        objectType: "thread",
        objectId: "t-1",
        matterRef: "M-9",
        at: noon(2),
      });
      await recordUsage(db, {
        surface: "word",
        accessPoint: "word",
        action: "word.ask",
        actionClass: "query",
        at: noon(1),
      });
    });
    await asApp(pool, asPrincipal(gone.id, ws.workspaceId), (db) =>
      recordUsage(db, {
        surface: "web",
        action: "thread.message_sent",
        actionClass: "query",
        at: noon(2),
      }),
    );
    await pool.query(`update core."user" set status = 'deprovisioned' where id = $1`, [gone.id]);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    const range = { from: dayStr(10), to: dayStr(0) };

    const store = createMemoryStore();
    const center = createCommandCenter(pool, { store });
    const job = await center.createExport(p, { range }, client);
    expect(job).toMatchObject({ status: "done", row_count: 3, gzip: false });
    expect(Date.parse(job.expires_at ?? "") - Date.parse(job.finished_at ?? "")).toBeGreaterThan(
      6.9 * DAY,
    );
    const key = `exports/${ws.workspaceId}/${job.id}.csv`;
    const bytes = await store.get(key);
    expect(bytes?.length).toBe(job.bytes);
    const lines = Buffer.from(bytes ?? [])
      .toString("utf8")
      .trim()
      .split("\r\n");
    expect(lines[0]).toBe(
      "event_id,timestamp_utc,user_email,user_status,user_role,groups,access_point,surface,subsurface,action,action_class,object_type,object_id,matter_ref,source_kinds,document_count,model,input_tokens,output_tokens,cost_usd,duration_ms",
    );
    const full =
      lines.find((l) => l.includes("thread.message_sent") && l.includes(ben.email)) ?? "";
    const cols = full.split(",");
    expect(cols).toHaveLength(21);
    expect(cols.slice(2, 6)).toEqual([ben.email, "active", "Associate", "Lit team"]);
    expect(cols[1]).toBe(`${dayStr(2)}T12:00:00.000Z`);
    expect(cols.slice(9, 21)).toEqual([
      "thread.message_sent",
      "query",
      "thread",
      "t-1",
      "M-9",
      "vault|knowledge",
      "2",
      "m-1",
      "100",
      "20",
      "0.012300",
      "900",
    ]);
    expect(lines.some((l) => l.includes(",former,"))).toBe(true);

    const noFormer = await center.createExport(p, { range, includeFormer: false }, client);
    expect(noFormer.row_count).toBe(2);
    const onlyWord = await center.createExport(p, { range, surfaces: ["word"] }, client);
    expect(onlyWord.row_count).toBe(1);

    const listed = await center.listExports(p);
    expect(listed.map((j) => j.id)).toEqual(
      expect.arrayContaining([job.id, noFormer.id, onlyWord.id]),
    );

    // Over the size limit the file is stored gzipped.
    const small = createCommandCenter(pool, { store, gzipOverBytes: 100 });
    const zipped = await small.createExport(p, { range }, client);
    expect(zipped.gzip).toBe(true);
    const file = await small.downloadExport(p, zipped.id);
    expect(file.filename.endsWith(".csv.gz")).toBe(true);
    expect(gunzipSync(file.bytes).toString("utf8").trim().split("\r\n")).toHaveLength(4);
    expect(await store.get(`exports/${ws.workspaceId}/${zipped.id}.csv.gz`)).not.toBeNull();

    // One audit event per export, with the parameters and no event data.
    const trail = (await auditTrail(pool, ws.workspaceId)).filter(
      (a) => a.action === "analytics.export_created",
    );
    expect(trail).toHaveLength(4);
    expect(trail[0]?.details).toMatchObject({
      from: range.from,
      to: range.to,
      include_former: true,
    });
  });

  it("refuses a range over 366 days with 422 and unknown surfaces with 400", async () => {
    const ws = await seedMember(pool);
    const h = harness();
    const cookie = await h.signIn(ws);
    const tooLong = await h.call(cookie, "POST", "/admin/analytics/exports", {
      from: dayStr(366),
      to: dayStr(0),
    });
    expect(tooLong.status).toBe(422);
    expect(await h.json(tooLong)).toMatchObject({ code: "RANGE_TOO_LARGE" });
    const longest = await h.call(cookie, "POST", "/admin/analytics/exports", {
      from: dayStr(365),
      to: dayStr(0),
    });
    expect(longest.status).toBe(201);
    const bad = await h.call(cookie, "POST", "/admin/analytics/exports", {
      from: dayStr(5),
      to: dayStr(0),
      surfaces: ["nope"],
    });
    expect(bad.status).toBe(400);
    const missing = await h.call(
      cookie,
      "GET",
      `/admin/analytics/exports/${randomUUID()}/download`,
    );
    expect(missing.status).toBe(404);
  });

  it("serves exports and CSVs over HTTP with the right headers", async () => {
    const ws = await seedMember(pool);
    const p = asPrincipal(ws.userId, ws.workspaceId);
    await pool.query(`update core."user" set name = '=HYPERLINK("x")' where id = $1`, [ws.userId]);
    await asApp(pool, p, (db) =>
      recordUsage(db, {
        surface: "web",
        action: "thread.message_sent",
        actionClass: "query",
        counter: "threads",
        at: noon(2),
      }),
    );
    await materialise();
    const h = harness();
    const cookie = await h.signIn(ws);
    const created = await h.json(
      await h.call(cookie, "POST", "/admin/analytics/exports", { from: dayStr(5), to: dayStr(0) }),
    );
    expect(created.export.row_count).toBe(1);
    const dl = await h.call(
      cookie,
      "GET",
      `/admin/analytics/exports/${created.export.id}/download`,
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("text/csv");
    expect((await dl.text()).split("\r\n")[0]).toBe(EXPORT_COLUMNS.join(","));
    const csv = await h.call(
      cookie,
      "GET",
      `/admin/analytics/csv?chart=users&from=${dayStr(5)}&to=${dayStr(0)}`,
    );
    expect(csv.headers.get("content-disposition")).toContain("users-by-activity");
    // A name that would run as a spreadsheet formula is quoted.
    expect(await csv.text()).toContain(`"'=HYPERLINK(""x"")"`);
    const bad = await h.call(cookie, "GET", "/admin/analytics/overview?from=2026-01-01");
    expect(bad.status).toBe(400);
    const outcomes = await h.call(cookie, "GET", "/admin/analytics/csv?chart=outcomes");
    expect(await outcomes.text()).toContain("baselines are yours");
    const put = await h.call(cookie, "PUT", "/admin/analytics/baselines/draft_exported", {
      hours: 2.25,
      note: "n",
    });
    expect(put.status).toBe(200);
    const listed = await h.json(await h.call(cookie, "GET", "/admin/analytics/baselines"));
    expect(
      listed.baselines.find((b: { workflow_type: string }) => b.workflow_type === "draft_exported"),
    ).toMatchObject({
      hours_per_completion: 2.25,
    });
    const nope = await h.call(cookie, "PUT", "/admin/analytics/baselines/made_up", { hours: 1 });
    expect(nope.status).toBe(400);
  });
});
