import { randomUUID } from "node:crypto";
import { EmailCategory, NOTIFICATION_KINDS, notificationKinds } from "@legallabs/contracts";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth, type Principal } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { CATALOGUE, type NotificationEvent } from "./catalogue.js";
import { createFakeEmailProvider, createLogEmailProvider } from "./email-port.js";
import { createEmailWorker } from "./email-worker.js";
import { createNotifications } from "./notifications.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "test" };
const principal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

const BASE = "https://app.legallabs.test";

// The clock the notifier uses when queueing; tests move it to pick a local time.
function harness() {
  let current = new Date("2026-03-10T12:00:00Z");
  const notifications = createNotifications(pool, { now: () => current });
  const provider = createFakeEmailProvider();
  const worker = createEmailWorker(pool, { provider, baseUrl: BASE });
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
    notifications,
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
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
    return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
  };
  const at = (iso: string) => {
    current = new Date(iso);
  };
  return { notifications, provider, worker, signIn, call, at, now: () => current };
}

async function colleague(m: Seeded, tag = "ben"): Promise<Seeded> {
  const email = `${tag}-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, '{threads.use}') returning id",
    [m.workspaceId, `User ${email}`],
  );
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role.rows[0]?.id],
  );
  const userId = user.rows[0]?.id ?? "";
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

const event = (
  over: Partial<NotificationEvent> & Pick<NotificationEvent, "kind" | "people">,
): NotificationEvent => ({
  actorId: null,
  objectType: "task",
  objectId: randomUUID(),
  objectTitle: "Review the indemnity",
  ...over,
});

const outboxCount = async (userId: string) =>
  Number(
    (
      await pool.query("select count(*)::int n from notify.email_outbox where user_id = $1", [
        userId,
      ])
    ).rows[0].n,
  );

async function twoPeople() {
  const h = harness();
  const ana = await seedMember(pool);
  const ben = await colleague(ana);
  const anaCookie = await h.signIn(ana);
  const benCookie = await h.signIn(ben);
  return { h, ana, ben, anaCookie, benCookie };
}

describe("notification email", () => {
  it("sends an action-required email at once, with the title, actor, action and a link only", async () => {
    const { h, ana, ben } = await twoPeople();
    const id = randomUUID();
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "task.assigned",
        actorId: ana.userId,
        objectId: id,
        people: { assignee: ben.userId },
        detail: "THE-DETAIL-TEXT",
      }),
    );
    const out = await h.worker.runOnce(h.now());
    expect(out).toEqual({ sent: 1, failed: 0 });
    const mail = h.provider.sent[0];
    expect(mail?.to.email).toBe(ben.email);
    expect(mail?.subject).toBe("A task was assigned to you: Review the indemnity");
    expect(mail?.text).toContain(`${BASE}/#/tasks/${id}`);
    expect(mail?.text).toContain("By ");
    expect(mail?.text).not.toContain("THE-DETAIL-TEXT");
    const row = await pool.query(
      "select email_sent_at from notify.notification where user_id = $1",
      [ben.userId],
    );
    expect(row.rows[0].email_sent_at).not.toBeNull();
    // Sent once: the next pass has nothing.
    expect(await h.worker.runOnce(new Date(h.now().getTime() + 3600e3))).toEqual({
      sent: 0,
      failed: 0,
    });
  });

  it("sends nothing for a category the workspace locked off, even if the person turned it on", async () => {
    const { h, ana, ben, anaCookie, benCookie } = await twoPeople();
    await h.call(anaCookie, "PATCH", "/admin/notification-settings", {
      categories: [{ category: "tasks", default: false, locked: true }],
    });
    await h.call(benCookie, "PATCH", "/notification-settings", {
      categories: [{ category: "tasks", value: true, mode: "all" }],
    });
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    expect(await outboxCount(ben.userId)).toBe(0);
    expect(await h.worker.runOnce(h.now())).toEqual({ sent: 0, failed: 0 });
    expect(h.provider.sent).toHaveLength(0);
    // The in-app notification is still made.
    expect((await h.call(benCookie, "GET", "/notifications")).body.items).toHaveLength(1);
  });

  it("holds a non-action email until quiet hours end at 07:00 local, while action-required goes now", async () => {
    const { h, ana, ben, benCookie } = await twoPeople();
    await h.call(benCookie, "PATCH", "/notification-settings", {
      quiet_hours: { from: "22:00", to: "07:00", tz: "America/New_York" },
      categories: [{ category: "tasks", value: true, mode: "all" }],
    });
    // 23:00 in New York.
    h.at("2026-03-11T03:00:00Z");
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.status_changed", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    const due = await pool.query<{ scheduled_at: Date; action_required: boolean }>(
      `select o.scheduled_at, (o.payload->>'action_required')::boolean action_required
         from notify.email_outbox o where o.user_id = $1 order by o.created_at`,
      [ben.userId],
    );
    expect(due.rows[0]?.scheduled_at.toISOString()).toBe("2026-03-11T11:00:00.000Z");
    expect(due.rows[1]?.scheduled_at.toISOString()).toBe("2026-03-11T03:00:00.000Z");

    expect(await h.worker.runOnce(new Date("2026-03-11T03:05:00Z"))).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(h.provider.sent.map((m) => m.subject)).toEqual([
      "A task was assigned to you: Review the indemnity",
    ]);
    expect(await h.worker.runOnce(new Date("2026-03-11T10:59:00Z"))).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(await h.worker.runOnce(new Date("2026-03-11T11:00:01Z"))).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(h.provider.sent[1]?.subject).toBe("Task status changed: Review the indemnity");
  });

  it("batches non-action mail per person into one email per 15-minute window", async () => {
    const { h, ana, ben, benCookie } = await twoPeople();
    await h.call(benCookie, "PATCH", "/notification-settings", {
      categories: [{ category: "tasks", value: true, mode: "all" }],
    });
    h.at("2026-03-10T12:01:00Z");
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "task.status_changed",
          actorId: ana.userId,
          objectTitle: title,
          people: { assignee: ben.userId },
        }),
      );
    }
    // Not yet: the window closes at 12:15.
    expect(await h.worker.runOnce(new Date("2026-03-10T12:10:00Z"))).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(await h.worker.runOnce(new Date("2026-03-10T12:15:01Z"))).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(h.provider.sent).toHaveLength(1);
    const mail = h.provider.sent[0];
    expect(mail?.subject).toBe("3 updates in LegalLabs");
    for (const title of ["Alpha", "Beta", "Gamma"]) expect(mail?.text).toContain(title);
    const marked = await pool.query(
      "select count(*)::int n from notify.notification where user_id = $1 and email_sent_at is not null",
      [ben.userId],
    );
    expect(marked.rows[0].n).toBe(3);
  });

  it("adds the first 300 characters of a comment only when the workspace includes content", async () => {
    const { h, ana, ben, anaCookie, benCookie } = await twoPeople();
    await h.call(benCookie, "PATCH", "/notification-settings", {
      categories: [{ category: "tasks", value: true, mode: "all" }],
    });
    const comment = `${"c".repeat(300)}TAIL-BEYOND-LIMIT`;
    const comment1 = async () => {
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "task.commented",
          actorId: ana.userId,
          people: { participants: [ben.userId] },
          detail: comment,
        }),
      );
    };

    await comment1();
    await h.worker.runOnce(new Date("2026-03-10T12:15:01Z"));
    expect(h.provider.sent[0]?.text).not.toContain("ccc");

    await h.call(anaCookie, "PATCH", "/admin/notification-settings", { include_content: true });
    await comment1();
    await h.worker.runOnce(new Date("2026-03-10T12:15:02Z"));
    const text = h.provider.sent[1]?.text ?? "";
    expect(text).toContain("c".repeat(300));
    expect(text).not.toContain("TAIL-BEYOND-LIMIT");
  });

  it("emails a long run's completion in action-only mode but not a short one", async () => {
    const { h, ana, ben, benCookie } = await twoPeople();
    await h.call(benCookie, "GET", "/notification-settings");
    const run = (longRunning: boolean) =>
      h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "thread.run.completed",
          objectType: "run",
          actorId: null,
          longRunning,
          people: { runner: ben.userId },
        }),
      );
    await run(false);
    expect(await outboxCount(ben.userId)).toBe(0);
    await run(true);
    expect(await outboxCount(ben.userId)).toBe(1);
  });

  it("never emails in-app-only kinds, and never carries response, prompt or memory text", async () => {
    const { h, ana, ben, anaCookie, benCookie } = await twoPeople();
    await h.call(anaCookie, "PATCH", "/admin/notification-settings", { include_content: true });
    await h.call(benCookie, "PATCH", "/notification-settings", {
      categories: EmailCategory.options.map((category) => ({
        category,
        value: true,
        mode: "all",
      })),
    });
    const everyone = [ben.userId];
    for (const kind of notificationKinds) {
      const meta = NOTIFICATION_KINDS[kind];
      // Comment and question kinds may carry their comment; every other detail is something
      // a model or a memory said, and must never reach a mailbox.
      const detail = CATALOGUE[kind].body ? "COMMENT-TEXT" : "PROMPT-RESPONSE-MEMORY-SECRET";
      const before = await outboxCount(ben.userId);
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind,
          actorId: ana.userId,
          detail,
          longRunning: true,
          people: {
            owner: ben.userId,
            runner: ben.userId,
            recipients: everyone,
            assignee: ben.userId,
            creator: ben.userId,
            requester: ben.userId,
            mentioned: everyone,
            approvers: everyone,
            admins: everyone,
            participants: everyone,
            optedIn: everyone,
          },
        }),
      );
      const queued = (await outboxCount(ben.userId)) - before;
      if (!meta.email || !meta.in_app) expect(queued, kind).toBe(0);
    }
    await h.worker.runOnce(new Date("2026-03-11T00:00:00Z"));
    expect(h.provider.sent.length).toBeGreaterThan(0);
    for (const mail of h.provider.sent) {
      expect(`${mail.subject}\n${mail.text}`).not.toContain("SECRET");
    }
    const memoryMail = await pool.query(
      "select 1 from notify.email_outbox where user_id = $1 and category = 'memory'",
      [ben.userId],
    );
    expect(memoryMail.rowCount).toBe(0);
  });

  it("retries a failed send after a back-off and records the error without message text", async () => {
    const { h, ana, ben } = await twoPeople();
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    h.provider.failNext();
    expect(await h.worker.runOnce(h.now())).toEqual({ sent: 0, failed: 1 });
    const failed = await pool.query(
      "select error, attempts from notify.email_outbox where user_id = $1",
      [ben.userId],
    );
    expect(failed.rows[0]).toEqual({ error: "send failed: Error", attempts: 1 });
    expect(await h.worker.runOnce(new Date(h.now().getTime() + 60e3))).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(await h.worker.runOnce(new Date(h.now().getTime() + 6 * 60e3))).toEqual({
      sent: 1,
      failed: 0,
    });
  });

  it("starts and stops its timer", async () => {
    const { h } = await twoPeople();
    const worker = createEmailWorker(pool, {
      provider: h.provider,
      baseUrl: BASE,
      intervalMs: 20,
    });
    worker.start();
    worker.start();
    await worker.stop();
  });
});

describe("the log email provider", () => {
  it("logs the recipient's domain and the subject, and nothing else", async () => {
    const lines: string[] = [];
    const provider = createLogEmailProvider((line) => lines.push(line));
    await provider.send({
      to: { email: "ben@firm.example", name: "Ben Private" },
      subject: "Plan ready to approve: Deal",
      text: "BODY-TEXT with a link",
    });
    expect(lines).toEqual(["email to @firm.example: Plan ready to approve: Deal"]);
  });
});
