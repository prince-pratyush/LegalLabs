import { randomBytes, randomUUID } from "node:crypto";
import { readAuditChain, verifyAuditChain } from "@legallabs/db";
import { createGateway } from "@legallabs/model-gateway";
import { contentKey, createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import type { NotificationEvent } from "../notifications/catalogue.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createVaults } from "../vaults/vaults.js";
import { createRetentionSweepJob } from "./job.js";
import { createRetention } from "./service.js";

const pool = testPool();
afterAll(() => pool.end());

const X = "The supplier accepts liability for direct loss.";
const Y = "The buyer accepts liability for indirect loss on matter 77.";

function harness() {
  const store = createMemoryStore();
  const events: NotificationEvent[] = [];
  const documents = testDocuments(pool, { store });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    vaults: createVaults(pool, { documents, store }),
    retention: createRetention(pool, {
      store,
      notifications: {
        notify: async (_p, event) => {
          events.push(event);
        },
      },
    }),
    clientIp: () => "203.0.113.9",
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
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const newVault = async (cookie: string, name: string) =>
    (await call(cookie, "POST", "/vaults", { name })).body.vault.id as string;
  const upload = async (cookie: string, vault: string, name: string, content: string) => {
    const form = new FormData();
    form.set("file", new File([content], name));
    const res = await app.request(`/api/v1/vaults/${vault}/files`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    return ((await res.json()) as { file: { id: string } }).file.id;
  };
  const job = () => createRetentionSweepJob(pool, { store, notifications: undefined as never });
  return { app, store, events, documents, signIn, call, newVault, upload, job };
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];
const count = async (sql: string, params: unknown[] = []) =>
  Number(Object.values((await q(sql, params))[0] ?? { n: 0 })[0]);

async function colleague(m: Seeded, permissions: string[]) {
  const email = `ben-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await q<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `R ${email}`, permissions],
  );
  const user = await q<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role[0]?.id],
  );
  const userId = user[0]?.id ?? "";
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

async function matter(m: Seeded) {
  const r = await q<{ id: string }>(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
     values ($1, 'C1', 'Client', $2, 'M', 'open') returning id`,
    [m.workspaceId, `M-${randomUUID().slice(0, 6)}`],
  );
  return r[0]?.id ?? "";
}

async function sqlVault(m: Seeded, opts: { matterId?: string; hours?: number } = {}) {
  const r = await q<{ id: string }>(
    `insert into content.vault (workspace_id, owner_id, name, matter_id, retention_hours)
     values ($1, $2, 'V', $3, $4) returning id`,
    [m.workspaceId, m.userId, opts.matterId ?? null, opts.hours ?? null],
  );
  return r[0]?.id ?? "";
}

async function sqlDoc(m: Seeded, vault: string, ageHours: number) {
  const age = `${ageHours} hours`;
  const d = await q<{ id: string }>(
    `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id, created_at)
     values ($1, $2, 'd.txt', 'text/plain', 10, $3, now() - $4::interval) returning id`,
    [m.workspaceId, m.userId, vault, age],
  );
  const id = d[0]?.id ?? "";
  await pool.query(
    `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by, created_at)
     values ($1, $2, $3, 1, $2, now() - $4::interval)`.replace("$2, $3, 1, $2", "$2, $3, 1, $5"),
    [m.workspaceId, id, randomBytes(32), age, m.userId],
  );
  return id;
}

async function policy(m: Seeded, scope: string, scopeId: string, hours: number | null) {
  await pool.query(
    "insert into retention.policy (workspace_id, scope, scope_id, hours) values ($1, $2, $3, $4)",
    [m.workspaceId, scope, scopeId, hours],
  );
}

async function thread(m: Seeded, ageHours: number, versionId?: string) {
  const t = await q<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, title, last_activity_at)
     values ($1, $2, 'Thread', now() - $3::interval) returning id`,
    [m.workspaceId, m.userId, `${ageHours} hours`],
  );
  const id = t[0]?.id ?? "";
  const msg = await q<{ id: string }>(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'user', 'privileged question') returning id`,
    [m.workspaceId, id],
  );
  const mid = msg[0]?.id ?? "";
  if (versionId) {
    await pool.query(
      "insert into work.thread_document (thread_id, version_id, workspace_id) values ($1, $2, $3)",
      [id, versionId, m.workspaceId],
    );
    await pool.query(
      `insert into work.citation (message_id, ordinal, workspace_id, anchor, version_id, status)
       values ($1, 0, $2, 0, $3, 'mismatch')`,
      [mid, m.workspaceId, versionId],
    );
  }
  const draft = await q<{ id: string }>(
    `insert into work.draft (workspace_id, thread_id, owner_id, kind, title)
     values ($1, $2, $3, 'notepad', 'Draft') returning id`,
    [m.workspaceId, id, m.userId],
  );
  await pool.query(
    `insert into work.draft_version (draft_id, no, workspace_id, body, author, created_by)
     values ($1, 1, $2, 'body', 'user', $3)`,
    [draft[0]?.id, m.workspaceId, m.userId],
  );
  const run = await q<{ id: string }>(
    `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id)
     values ($1, $2, $3, 'thread', 'done', $4) returning id`,
    [m.workspaceId, id, m.userId, mid],
  );
  await pool.query(
    "insert into work.run_event (run_id, seq, workspace_id, type, data) values ($1, 1, $2, 'x', '{}')",
    [run[0]?.id, m.workspaceId],
  );
  return id;
}

async function reviewTable(m: Seeded, ageHours: number) {
  const t = await q<{ id: string }>(
    `insert into work.review_table (workspace_id, owner_id, name, source_kind, updated_at)
     values ($1, $2, 'Table', 'uploads', now() - $3::interval) returning id`,
    [m.workspaceId, m.userId, `${ageHours} hours`],
  );
  const id = t[0]?.id ?? "";
  await pool.query(
    `insert into work.rt_column (workspace_id, table_id, ordinal, label, type, prompt)
     values ($1, $2, 0, 'Col', 'free', 'p')`,
    [m.workspaceId, id],
  );
  await pool.query(
    `insert into work.rt_row (workspace_id, table_id, ordinal, document_ids)
     values ($1, $2, 0, array[$3::uuid])`,
    [m.workspaceId, id, randomUUID()],
  );
  return id;
}

const expiredIds = async (m: Seeded) =>
  new Set(
    (
      await q<{ object_id: string }>(
        "select object_id from retention.expired_objects($1) where not held",
        [m.workspaceId],
      )
    ).map((r) => r.object_id),
  );

// What the owner can still see, with row-level security on.
async function visible(m: Seeded, sql: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role legallabs_app");
    await c.query(
      "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [m.userId, m.workspaceId],
    );
    const { rows } = await c.query(sql, params);
    return Number(rows[0]?.n ?? 0);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

describe("retention: deletion verified", () => {
  it("bins expired objects, then removes rows, files and index entries for good", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const v1 = await h.newVault(cookie, "Deal room");
    const v2 = await h.newVault(cookie, "Held room");
    const a = await h.upload(cookie, v1, "a.txt", X);
    const b = await h.upload(cookie, v1, "b.txt", Y);
    // Same bytes as a, in a held vault: the stored file must outlive a's purge.
    const c = await h.upload(cookie, v2, "c.txt", X);
    await h.documents.worker.drain(m.workspaceId);
    expect(
      (
        await h.call(cookie, "PUT", "/admin/retention/holds", {
          object_type: "vault",
          object_id: v2,
          held: true,
          reason: "Litigation",
        })
      ).status,
    ).toBe(200);

    const versionA = (
      await q<{ id: string; sha256: Buffer }>(
        "select id, sha256 from content.document_version where document_id = $1",
        [a],
      )
    )[0];
    const shaB = (
      await q<{ sha256: Buffer }>(
        "select sha256 from content.document_version where document_id = $1",
        [b],
      )
    )[0]?.sha256;
    const keyA = contentKey(m.workspaceId, versionA?.sha256.toString("hex") ?? "");
    const keyB = contentKey(m.workspaceId, shaB?.toString("hex") ?? "");
    expect(await h.store.get(keyA)).not.toBeNull();
    expect(
      await count("select count(*) n from content.chunk where version_id = $1", [versionA?.id]),
    ).toBeGreaterThan(0);

    const old = "10 days";
    await pool.query(
      "update content.document set created_at = now() - $1::interval where workspace_id = $2",
      [old, m.workspaceId],
    );
    await pool.query(
      "update content.document_version set created_at = now() - $1::interval where workspace_id = $2",
      [old, m.workspaceId],
    );
    const t1 = await thread(m, 240, versionA?.id);
    const t2 = await thread(m, 1);
    const r1 = await reviewTable(m, 240);

    const est = await h.call(cookie, "GET", "/admin/retention/estimate?scope=workspace&hours=24");
    expect(est.body).toMatchObject({
      threads: 1,
      documents: 2,
      reviewTables: 1,
      total: 4,
      held: 1,
    });
    const saved = await h.call(cookie, "PUT", "/admin/retention/policy", {
      scope: "workspace",
      hours: 24,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.estimate.total).toBe(4);
    expect(h.events.some((e) => e.kind === "admin.retention_deletion_scheduled")).toBe(true);

    const first = await h.job().runOnce();
    expect([first.errors, first.problems]).toEqual([[], []]);
    expect(first).toMatchObject({ binned: 4, purged: 0 });
    // Invisible to the owner at once; the stored file is still there for a restore.
    expect(await visible(m, "select count(*) n from work.thread where id = $1", [t1])).toBe(0);
    expect(await visible(m, "select count(*) n from work.message where thread_id = $1", [t1])).toBe(
      0,
    );
    expect(await visible(m, "select count(*) n from work.draft where thread_id = $1", [t1])).toBe(
      0,
    );
    expect(await visible(m, "select count(*) n from work.review_table where id = $1", [r1])).toBe(
      0,
    );
    expect(await visible(m, "select count(*) n from content.document where id = $1", [a])).toBe(0);
    expect(await visible(m, "select count(*) n from work.thread where id = $1", [t2])).toBe(1);
    expect(await visible(m, "select count(*) n from content.document where id = $1", [c])).toBe(1);
    expect(await h.store.get(keyA)).not.toBeNull();
    expect((await h.call(cookie, "GET", "/admin/retention/bin")).body.items).toHaveLength(4);

    // Nothing is removed while the 30 days run.
    expect(await h.job().runOnce()).toMatchObject({ binned: 0, purged: 0 });
    await pool.query(
      "update retention.recycle_bin set restorable_until = now() - interval '1 day' where workspace_id = $1",
      [m.workspaceId],
    );
    const second = await h.job().runOnce();
    expect(second).toMatchObject({ purged: 4, filesDeleted: 1, failures: 0 });

    const gone = async (sql: string, ...ids: unknown[]) => expect(await count(sql, ids)).toBe(0);
    await gone("select count(*) from work.thread where id = $1", t1);
    await gone("select count(*) from work.message where thread_id = $1", t1);
    await gone(
      "select count(*) from work.citation where workspace_id = $1 and version_id is not null",
      m.workspaceId,
    );
    await gone("select count(*) from work.thread_document where thread_id = $1", t1);
    await gone("select count(*) from work.draft where thread_id = $1", t1);
    await gone("select count(*) from work.run where thread_id = $1", t1);
    // Only the kept thread's run events remain.
    expect(
      await count("select count(*) from work.run_event where workspace_id = $1", [m.workspaceId]),
    ).toBe(1);
    await gone("select count(*) from work.review_table where id = $1", r1);
    await gone("select count(*) from work.rt_column where table_id = $1", r1);
    await gone("select count(*) from content.document where id = any($1)", [a, b]);
    await gone("select count(*) from content.document_version where document_id = any($1)", [a, b]);
    await gone("select count(*) from content.document_blob where version_id = $1", versionA?.id);
    await gone("select count(*) from content.page where version_id = $1", versionA?.id);
    await gone("select count(*) from content.chunk where version_id = $1", versionA?.id);
    expect(await count("select count(*) from work.thread where id = $1", [t2])).toBe(1);
    expect(await count("select count(*) from content.document where id = $1", [c])).toBe(1);
    // b's file is gone; a's is kept because the held file still points at it.
    expect(await h.store.get(keyB)).toBeNull();
    expect(await h.store.get(keyA)).not.toBeNull();

    const bin = await q<{ purged_at: Date | null }>(
      "select purged_at from retention.recycle_bin where workspace_id = $1",
      [m.workspaceId],
    );
    expect(bin).toHaveLength(4);
    expect(bin.every((r) => r.purged_at)).toBe(true);
    const jobs = await q<{ report: { purged: Record<string, number>; files_released: number } }>(
      "select report from retention.deletion_job where workspace_id = $1 and kind = 'sweep' order by created_at",
      [m.workspaceId],
    );
    expect(jobs.at(-1)?.report.purged).toEqual({ threads: 1, documents: 2, review_tables: 1 });
    expect(jobs.at(-1)?.report.files_released).toBe(1);

    // The trail keeps what happened, and the chain still holds.
    const actions = (await auditTrail(pool, m.workspaceId)).map((r) => r.action as string);
    expect(actions.filter((x) => x === "retention.object_binned")).toHaveLength(4);
    expect(actions.filter((x) => x === "retention.object_purged")).toHaveLength(4);
    expect(actions).toEqual(
      expect.arrayContaining([
        "retention.policy_changed",
        "retention.sweep",
        "retention.hold_changed",
      ]),
    );
    const chain = verifyAuditChain(await readAuditChain(pool, m.workspaceId));
    expect(chain.ok).toBe(true);
  }, 60_000);
});

describe("retention: policies", () => {
  it("resolves precedence: specific scope wins, shortest of matter and vault, null is unlimited", async () => {
    const m = await seedMember(pool);
    await policy(m, "workspace", m.workspaceId, 50);
    const doc = async (vault: string) => sqlDoc(m, vault, 100);
    const v1 = await sqlVault(m); // workspace only
    const v2 = await sqlVault(m);
    await policy(m, "vault", v2, 200); // vault is looser, wins
    const v3 = await sqlVault(m);
    await policy(m, "vault", v3, 20);
    const m4 = await matter(m);
    const v4 = await sqlVault(m, { matterId: m4 });
    await policy(m, "vault", v4, 200);
    await policy(m, "matter", m4, 50); // shortest
    const v5 = await sqlVault(m);
    await policy(m, "vault", v5, null); // unlimited
    const v6 = await sqlVault(m, { hours: 20 }); // legacy hours
    const v7 = await sqlVault(m, { hours: 20 });
    await policy(m, "vault", v7, null); // row replaces legacy
    const m8 = await matter(m);
    const v8 = await sqlVault(m, { matterId: m8 });
    await policy(m, "matter", m8, null);
    await policy(m, "vault", v8, 20); // shortest non-null
    const m9 = await matter(m);
    const v9 = await sqlVault(m, { matterId: m9 });
    await policy(m, "matter", m9, null); // explicit unlimited, no fall through
    const docs: Record<string, string> = {};
    for (const [name, v] of Object.entries({ v1, v2, v3, v4, v5, v6, v7, v8, v9 }))
      docs[name] = await doc(v);
    const expired = await expiredIds(m);
    const hit = Object.keys(docs).filter((k) => expired.has(docs[k] ?? ""));
    expect(hit.sort()).toEqual(["v1", "v3", "v4", "v6", "v8"]);
  });

  it("refuses under 3 hours with 422 RETENTION_MIN and gates admins only", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    for (const hours of [0, 2]) {
      const res = await h.call(cookie, "PUT", "/admin/retention/policy", {
        scope: "workspace",
        hours,
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("RETENTION_MIN");
    }
    expect(
      (await h.call(cookie, "GET", "/admin/retention/estimate?scope=workspace&hours=2")).status,
    ).toBe(422);
    expect(
      (await h.call(cookie, "PUT", "/admin/retention/policy", { scope: "workspace", hours: 3 }))
        .status,
    ).toBe(200);
    expect(
      (await h.call(cookie, "PUT", "/admin/retention/policy", { scope: "workspace", hours: null }))
        .status,
    ).toBe(200);
    const listed = await h.call(cookie, "GET", "/admin/retention");
    expect(listed.body.workspace.hours).toBeNull();
    expect(listed.body.exemptions.map((e: { type: string }) => e.type)).toContain("audit_event");

    const ben = await colleague(m, ["threads.use"]);
    const bc = await h.signIn(ben);
    for (const [method, path, body] of [
      ["GET", "/admin/retention", undefined],
      ["GET", "/admin/retention/estimate?scope=workspace&hours=24", undefined],
      ["PUT", "/admin/retention/policy", { scope: "workspace", hours: 24 }],
      [
        "PUT",
        "/admin/retention/holds",
        { object_type: "matter", object_id: randomUUID(), held: true, reason: "x" },
      ],
      ["GET", "/admin/retention/bin", undefined],
      ["POST", `/admin/retention/bin/${randomUUID()}/restore`, undefined],
      ["GET", "/admin/retention/jobs", undefined],
    ] as const) {
      expect((await h.call(bc, method, path, body)).status, path).toBe(403);
    }
  });

  it("needs the typed workspace slug over 1,000 objects, and the estimate matches the sweep", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    await pool.query(
      `insert into work.thread (workspace_id, owner_id, title, last_activity_at)
       select $1, $2, 'T' || g, now() - interval '3 days' from generate_series(1, 1001) g`,
      [m.workspaceId, m.userId],
    );
    const body = { scope: "workspace", hours: 24 };
    const refused = await h.call(cookie, "PUT", "/admin/retention/policy", body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CONFIRM_REQUIRED");
    expect(refused.body.estimate.total).toBe(1001);
    expect(
      (await h.call(cookie, "PUT", "/admin/retention/policy", { ...body, confirm_slug: "nope" }))
        .status,
    ).toBe(409);
    expect(
      await count("select count(*) from retention.policy where workspace_id = $1", [m.workspaceId]),
    ).toBe(0);
    const ok = await h.call(cookie, "PUT", "/admin/retention/policy", {
      ...body,
      confirm_slug: m.slug,
    });
    expect(ok.status).toBe(200);
    const report = await h.job().runOnce();
    // Other workspaces' leftovers ride along in the same sweep, so count this one's bin.
    expect(report.errors).toEqual([]);
    expect(
      await count("select count(*) from retention.recycle_bin where workspace_id = $1", [
        m.workspaceId,
      ]),
    ).toBe(ok.body.estimate.total);
    const jobs = await h.call(cookie, "GET", "/admin/retention/jobs");
    expect(
      jobs.body.jobs.some(
        (j: { kind: string; status: string }) => j.kind === "policy_change" && j.status === "done",
      ),
    ).toBe(true);
  }, 120_000);
});

describe("retention: holds, exemptions, restore, isolation", () => {
  it("skips held objects and reports them, and exempt data is untouched", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const held = await thread(m, 500);
    const free = await thread(m, 500);
    const mt = await matter(m);
    const heldByMatter = (
      await q<{ id: string }>(
        `insert into work.thread (workspace_id, owner_id, title, matter_id, last_activity_at)
       values ($1, $2, 'M', $3, now() - interval '500 hours') returning id`,
        [m.workspaceId, m.userId, mt],
      )
    )[0]?.id;
    await pool.query(
      "insert into library.prompt (workspace_id, owner_id, name, body, updated_at) values ($1, $2, 'P', 'b', now() - interval '900 hours')",
      [m.workspaceId, m.userId],
    );
    const auditBefore = await count(
      "select count(*) from admin.audit_event where workspace_id = $1",
      [m.workspaceId],
    );
    expect(
      (
        await h.call(cookie, "PUT", "/admin/retention/holds", {
          object_type: "thread",
          object_id: held,
          held: true,
          reason: "Case 9",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.call(cookie, "PUT", "/admin/retention/holds", {
          object_type: "matter",
          object_id: mt,
          held: true,
          reason: "Case 10",
        })
      ).status,
    ).toBe(200);
    await h.call(cookie, "PUT", "/admin/retention/policy", { scope: "workspace", hours: 24 });
    expect(await h.job().runOnce()).toMatchObject({ binned: 1 });
    expect(
      await count("select count(*) from work.thread where id = $1 and deleted_at is null", [held]),
    ).toBe(1);
    expect(
      await count("select count(*) from work.thread where id = $1 and deleted_at is null", [
        heldByMatter,
      ]),
    ).toBe(1);
    expect(
      await count("select count(*) from work.thread where id = $1 and deleted_at is not null", [
        free,
      ]),
    ).toBe(1);
    const report = (
      await q<{ report: { skipped_held: number } }>(
        "select report from retention.deletion_job where kind = 'sweep' and workspace_id = $1",
        [m.workspaceId],
      )
    )[0]?.report;
    expect(report?.skipped_held).toBe(2);
    expect(
      await count("select count(*) from library.prompt where workspace_id = $1", [m.workspaceId]),
    ).toBe(1);
    expect(
      await count("select count(*) from admin.audit_event where workspace_id = $1", [
        m.workspaceId,
      ]),
    ).toBeGreaterThanOrEqual(auditBefore);

    // A hold set after binning stops the purge too.
    await h.call(cookie, "PUT", "/admin/retention/holds", {
      object_type: "thread",
      object_id: free,
      held: true,
      reason: "Late",
    });
    await pool.query(
      "update retention.recycle_bin set restorable_until = now() - interval '1 day' where workspace_id = $1",
      [m.workspaceId],
    );
    expect(await h.job().runOnce()).toMatchObject({ purged: 0 });
    expect(await count("select count(*) from work.thread where id = $1", [free])).toBe(1);
    expect(
      (
        await h.call(
          cookie,
          "POST",
          `/admin/retention/bin/${(await q<{ id: string }>("select id from retention.recycle_bin where workspace_id = $1", [m.workspaceId]))[0]?.id}/purge`,
        )
      ).status,
    ).toBe(409);
  });

  it("restores with a fresh clock, so the next sweep leaves it alone", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const t = await thread(m, 500);
    const vault = await sqlVault(m);
    const d = await sqlDoc(m, vault, 500);
    await h.call(cookie, "PUT", "/admin/retention/policy", { scope: "workspace", hours: 24 });
    expect(await h.job().runOnce()).toMatchObject({ binned: 2 });
    const items = (await h.call(cookie, "GET", "/admin/retention/bin")).body.items as {
      id: string;
      objectId: string;
    }[];
    for (const item of items)
      expect((await h.call(cookie, "POST", `/admin/retention/bin/${item.id}/restore`)).status).toBe(
        200,
      );
    expect(await visible(m, "select count(*) n from work.thread where id = $1", [t])).toBe(1);
    expect(await visible(m, "select count(*) n from content.document where id = $1", [d])).toBe(1);
    expect(await h.job().runOnce()).toMatchObject({ binned: 0 });
    expect(
      (await h.call(cookie, "POST", `/admin/retention/bin/${items[0]?.id}/restore`)).status,
    ).toBe(409);
    expect((await h.call(cookie, "GET", "/admin/retention/bin")).body.items).toEqual([]);
  });

  it("keeps workspaces apart", async () => {
    const h = harness();
    const a = await seedMember(pool);
    const b = await seedMember(pool);
    await thread(a, 500);
    const ca = await h.signIn(a);
    const cb = await h.signIn(b);
    await h.call(ca, "PUT", "/admin/retention/policy", { scope: "workspace", hours: 24 });
    await h.job().runOnce();
    const itemA = (await h.call(ca, "GET", "/admin/retention/bin")).body.items[0] as {
      id: string;
      objectId: string;
    };
    expect((await h.call(cb, "GET", "/admin/retention/bin")).body.items).toEqual([]);
    expect((await h.call(cb, "POST", `/admin/retention/bin/${itemA.id}/restore`)).status).toBe(404);
    expect(
      (
        await h.call(cb, "PUT", "/admin/retention/holds", {
          object_type: "thread",
          object_id: itemA.objectId,
          held: true,
          reason: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.call(cb, "PUT", "/admin/retention/policy", {
          scope: "vault",
          scope_id: randomUUID(),
          hours: 24,
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.call(cb, "GET", "/admin/retention/jobs")).body.jobs.filter(
        (j: { kind: string }) => j.kind === "sweep",
      ),
    ).toEqual([]);
  });
});

describe("retention: warnings", () => {
  // The call covers every workspace in the shared test database; keep this test's vaults.
  let mine: string[] = [];
  const due = async () =>
    (
      await q<{ vault_id: string; lead_days: number }>(
        "select vault_id, lead_days from retention.due_warnings()",
      )
    ).filter((w) => mine.includes(w.vault_id));

  it("warns once at 30, 7 and 1 days, and not when the policy is shorter than the lead", async () => {
    const m = await seedMember(pool);
    const vault = await sqlVault(m);
    mine = [vault];
    await policy(m, "vault", vault, 960); // 40 days
    const d = await sqlDoc(m, vault, 960 - 29 * 24);
    expect(await due()).toEqual([{ vault_id: vault, lead_days: 30 }]);
    expect(await due()).toEqual([]);
    const age = async (hours: number) => {
      await pool.query(
        "update content.document set created_at = now() - $2::interval where id = $1",
        [d, `${hours} hours`],
      );
      await pool.query(
        "update content.document_version set created_at = now() - $2::interval where document_id = $1",
        [d, `${hours} hours`],
      );
    };
    await age(960 - 6 * 24);
    expect(await due()).toEqual([{ vault_id: vault, lead_days: 7 }]);
    await age(960 - 10);
    expect(await due()).toEqual([{ vault_id: vault, lead_days: 1 }]);

    const short = await sqlVault(m);
    mine = [vault, short];
    await policy(m, "vault", short, 20); // shorter than every lead
    await sqlDoc(m, short, 10);
    expect((await due()).filter((w) => w.vault_id === short)).toEqual([]);
  });

  it("sends one notice at save when the policy is shorter than the first lead", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await sqlVault(m);
    const res = await h.call(cookie, "PUT", "/admin/retention/policy", {
      scope: "vault",
      scope_id: vault,
      hours: 48,
    });
    expect(res.status).toBe(200);
    expect(h.events.filter((e) => e.kind === "vault.retention_warning")).toHaveLength(1);
    // A long policy keeps the countdown instead.
    await h.call(cookie, "PUT", "/admin/retention/policy", {
      scope: "vault",
      scope_id: vault,
      hours: 24 * 60,
    });
    expect(h.events.filter((e) => e.kind === "vault.retention_warning")).toHaveLength(1);
  });
});
