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

// The database queues mail by its own clock. Every test file shares one database, and the
// worker takes whatever is due, so a test moves its own people's mail 100 years back (all of
// it alike, so the timing rules still hold) and runs the worker on the same shifted clock.
const SHIFT_HOURS = 876000;
const SHIFT_MS = SHIFT_HOURS * 3600e3;

function harness() {
  const people: string[] = [];
  const notifications = createNotifications(pool);
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
  // Runs the worker `afterMs` from now, having moved this test's new mail onto its clock.
  const run = async (afterMs = 1000) => {
    await pool.query(
      `update notify.email_outbox set scheduled_at = scheduled_at - make_interval(hours => $2)
        where user_id = any ($1::uuid[]) and scheduled_at > now() - interval '1 year'`,
      [people, SHIFT_HOURS],
    );
    return worker.runOnce(new Date(Date.now() + afterMs - SHIFT_MS));
  };
  return { notifications, provider, worker, signIn, call, run, people };
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
  h.people.push(ana.userId, ben.userId);
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
    const out = await h.run();
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
    expect(await h.run(3600e3)).toEqual({ sent: 0, failed: 0 });
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
    expect(await h.run()).toEqual({ sent: 0, failed: 0 });
    expect(h.provider.sent).toHaveLength(0);
    // The in-app notification is still made.
    expect((await h.call(benCookie, "GET", "/notifications")).body.items).toHaveLength(1);
  });

  it("holds a non-action email until quiet hours end, while action-required goes now", async () => {
    const { h, ana, ben, benCookie } = await twoPeople();
    // Quiet hours from an hour ago until an hour ahead, in UTC, so queueing happens inside them.
    const hhmm = (offsetHours: number) =>
      new Date(Date.now() + offsetHours * 3600e3).toISOString().slice(11, 16);
    const to = hhmm(1);
    await h.call(benCookie, "PATCH", "/notification-settings", {
      quiet_hours: { from: hhmm(-1), to, tz: "UTC" },
      categories: [{ category: "tasks", value: true, mode: "all" }],
    });
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.status_changed", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    // Moves the two rows onto the test clock (nothing is due yet an hour back).
    await h.run(-3600e3);
    const due = await pool.query<{ ms: string; action_required: boolean }>(
      `select (extract(epoch from o.scheduled_at + make_interval(hours => $2)) * 1000)::bigint ms,
              (o.payload->>'action_required')::boolean action_required
         from notify.email_outbox o where o.user_id = $1 order by o.created_at`,
      [ben.userId, SHIFT_HOURS],
    );
    const hold = Number(due.rows[0]?.ms);
    expect(hold).toBeGreaterThan(Date.now() + 50 * 60e3);
    expect(new Date(hold).toISOString().slice(11, 16)).toBe(to);
    expect(Number(due.rows[1]?.ms)).toBeLessThan(Date.now() + 5e3);

    expect(await h.run()).toEqual({ sent: 1, failed: 0 });
    expect(h.provider.sent.map((m) => m.subject)).toEqual([
      "A task was assigned to you: Review the indemnity",
    ]);
    expect(await h.run(hold - Date.now() - 60e3)).toEqual({ sent: 0, failed: 0 });
    expect(await h.run(hold - Date.now() + 1000)).toEqual({ sent: 1, failed: 0 });
    expect(h.provider.sent[1]?.subject).toBe("Task status changed: Review the indemnity");
  });

  it("batches non-action mail per person into one email per 15-minute window", async () => {
    const { h, ana, ben, benCookie } = await twoPeople();
    await h.call(benCookie, "PATCH", "/notification-settings", {
      categories: [{ category: "tasks", value: true, mode: "all" }],
    });
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
    // Not yet: the window closes at the next quarter hour, which is never now.
    expect(await h.run()).toEqual({ sent: 0, failed: 0 });
    expect(await h.run(16 * 60e3)).toEqual({
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
    await h.run(16 * 60e3);
    expect(h.provider.sent[0]?.text).not.toContain("ccc");

    await h.call(anaCookie, "PATCH", "/admin/notification-settings", { include_content: true });
    await comment1();
    await h.run(32 * 60e3);
    const text = h.provider.sent[1]?.text ?? "";
    expect(text).toContain("c".repeat(300));
    expect(text).not.toContain("TAIL-BEYOND-LIMIT");
  });

  it("emails a long run's completion in action-only mode but not a short one", async () => {
    const { h, ana, ben, benCookie } = await twoPeople();
    await h.call(benCookie, "GET", "/notification-settings");
    // A recipient is only told about an object they can open: here, their own thread.
    const thread = await pool.query<{ id: string }>(
      "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Mine') returning id",
      [ben.workspaceId, ben.userId],
    );
    const run = (longRunning: boolean) =>
      h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "thread.run.completed",
          objectType: "thread",
          objectId: thread.rows[0]?.id ?? "",
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
    await h.run(24 * 3600e3);
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
    expect(await h.run()).toEqual({ sent: 0, failed: 1 });
    const failed = await pool.query(
      "select error, attempts from notify.email_outbox where user_id = $1",
      [ben.userId],
    );
    expect(failed.rows[0]).toEqual({ error: "send failed: Error", attempts: 1 });
    expect(await h.run(61e3)).toEqual({ sent: 0, failed: 0 });
    expect(await h.run(6 * 60e3)).toEqual({
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
