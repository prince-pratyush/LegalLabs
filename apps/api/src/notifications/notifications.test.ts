import { randomUUID } from "node:crypto";
import type { Notification } from "@legallabs/contracts";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth, type Principal } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import { createRunLog } from "../runs/log.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { noKnowledge, noVaults } from "../threads/ports.js";
import { createThreads } from "../threads/threads.js";
import { createVaults } from "../vaults/vaults.js";
import { ActionRefused } from "./actions.js";
import type { NotificationEvent } from "./catalogue.js";
import { createNotifications } from "./notifications.js";
import { registerThreadActions } from "./register.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "test" };
const principal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

function harness() {
  const documents = testDocuments(pool);
  const notifications = createNotifications(pool);
  const base = testThreads(pool, documents);
  const threadService = createThreads(pool, {
    gateway: base.gateway,
    documents,
    log: createRunLog(pool),
    vaults: noVaults,
    knowledge: noKnowledge,
    notifier: notifications.notifier,
  });
  const vaults = createVaults(pool, {
    documents,
    store: createMemoryStore(),
    notifier: notifications.notifier,
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: { ...base, threads: threadService },
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
  return { app, notifications, threadService, vaults, signIn, call, documents };
}

// A second person in the workspace who can draft but not administer it.
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

interface Page {
  items: Notification[];
  unread_count: number;
  action_required_count: number;
  next_cursor?: string;
}

/** Reads server-sent events from a response until `want` returns true or time runs out. */
async function readEvents(
  res: Response,
  want: (events: { event: string; data: string }[]) => boolean,
  ms = 2000,
) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no stream");
  const decoder = new TextDecoder();
  const events: { event: string; data: string }[] = [];
  let buffer = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !want(events)) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ]);
    if (next === null || next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name && data) events.push({ event: name, data });
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe("the notifications hub", () => {
  it("streams an action-required task assignment within 2 seconds and lists it under Action required", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const benCookie = await h.signIn(ben);
    const stream = await h.app.request("/api/v1/notifications/stream", {
      headers: { cookie: benCookie },
    });
    expect(stream.status).toBe(200);
    const reading = readEvents(stream, (all) => all.some((e) => e.event === "notification"));
    // Let the stream take its first look before the event happens.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "task.assigned",
        actorId: ana.userId,
        people: { assignee: ben.userId },
      }),
    );
    const events = await reading;
    expect(Date.now() - started).toBeLessThan(2000);
    const got = events.find((e) => e.event === "notification");
    expect(got).toBeDefined();
    const sent = JSON.parse(got?.data ?? "{}").notification as Notification;
    expect(sent).toMatchObject({
      kind: "task.assigned",
      category: "tasks",
      action_required: true,
      count: 1,
      available: true,
    });
    expect(events.some((e) => e.event === "counts")).toBe(true);

    const tab = await h.call(benCookie, "GET", "/notifications?tab=action_required");
    expect((tab.body as Page).items.map((i) => i.id)).toEqual([sent.id]);
    expect(tab.body).toMatchObject({ unread_count: 1, action_required_count: 1 });
    const count = await h.call(benCookie, "GET", "/notifications/unread-count");
    expect(count.body).toEqual({ unread: 1, action_required: 1 });
    // Ana never sees Ben's.
    const anaCookie = await h.signIn(ana);
    expect(((await h.call(anaCookie, "GET", "/notifications")).body as Page).items).toEqual([]);
  });

  it("sends each notification once and closes the stream when the session is revoked", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const benCookie = await h.signIn(ben);
    const stream = await h.app.request("/api/v1/notifications/stream", {
      headers: { cookie: benCookie },
    });
    const reading = readEvents(stream, () => false, 1500);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const n of [1, 2]) {
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "task.assigned",
          actorId: ana.userId,
          objectTitle: `Task ${n}`,
          people: { assignee: ben.userId },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const events = await reading;
    expect(events.filter((e) => e.event === "notification")).toHaveLength(2);

    const again = await h.app.request("/api/v1/notifications/stream", {
      headers: { cookie: benCookie },
    });
    const closing = readEvents(again, () => false, 3000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await pool.query("update core.session set revoked_at = now() where user_id = $1", [ben.userId]);
    const started = Date.now();
    h.notifications.hub.publish(ben.userId);
    await closing;
    // Ended by the revoked session, not by the read timing out.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("merges three comments on one cell within ten minutes into one unread with a count of 3", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const object = randomUUID();
    for (const text of ["one", "two", "three"]) {
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "table.cell_commented",
          // An object type the hub doesn't re-check, so the made-up id stays available.
          objectType: "task",
          objectId: object,
          actorId: ana.userId,
          detail: text,
          people: { assignee: ben.userId },
        }),
      );
    }
    const cookie = await h.signIn(ben);
    const page = (await h.call(cookie, "GET", "/notifications")).body as Page;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ count: 3, body: "three", kind: "table.cell_commented" });
    expect(page.unread_count).toBe(1);
  });

  it("sends nothing to the actor for their own action", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    await h.notifications.notifier.notify(
      principal(ben),
      event({
        kind: "task.commented",
        actorId: ben.userId,
        detail: "my own note",
        people: { participants: [ben.userId], assignee: ben.userId },
      }),
    );
    const cookie = await h.signIn(ben);
    expect(((await h.call(cookie, "GET", "/notifications")).body as Page).items).toEqual([]);
    expect((await h.call(cookie, "GET", "/notifications/unread-count")).body).toEqual({
      unread: 0,
      action_required: 0,
    });
  });

  it("marks all read without touching archived items, and keeps archived ones under Archived only", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    for (const title of ["first", "second", "third"]) {
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
    const cookie = await h.signIn(ben);
    const all = (await h.call(cookie, "GET", "/notifications")).body as Page;
    expect(all.unread_count).toBe(3);
    const archived = all.items[0] as Notification;
    const patched = await h.call(cookie, "PATCH", `/notifications/${archived.id}`, {
      archived: true,
    });
    expect(patched.body.notification.archived_at).toBeTruthy();

    const visible = (await h.call(cookie, "GET", "/notifications")).body as Page;
    expect(visible.items.map((i) => i.id)).not.toContain(archived.id);
    const inArchive = (await h.call(cookie, "GET", "/notifications?state=archived")).body as Page;
    expect(inArchive.items.map((i) => i.id)).toEqual([archived.id]);

    expect((await h.call(cookie, "POST", "/notifications/read-all")).status).toBe(204);
    const after = (await h.call(cookie, "GET", "/notifications")).body as Page;
    expect(after.unread_count).toBe(0);
    expect(after.items.every((i) => i.read_at)).toBe(true);
    const archive = (await h.call(cookie, "GET", "/notifications?state=archived")).body as Page;
    expect(archive.items).toHaveLength(1);
    expect(archive.items[0]?.read_at).toBeUndefined();
    const unread = (await h.call(cookie, "GET", "/notifications?state=unread")).body as Page;
    expect(unread.items).toEqual([]);

    const back = await h.call(cookie, "PATCH", `/notifications/${archived.id}`, { read: false });
    expect(back.body.notification.read_at).toBeUndefined();
    expect(
      (await h.call(cookie, "PATCH", `/notifications/${randomUUID()}`, { read: true })).status,
    ).toBe(404);
    expect((await h.call(cookie, "PATCH", `/notifications/${archived.id}`, {})).status).toBe(400);
  });

  it("pages the list with a cursor", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    for (let i = 0; i < 55; i++) {
      await h.notifications.notifier.notify(
        principal(ana),
        event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
      );
    }
    const cookie = await h.signIn(ben);
    const first = (await h.call(cookie, "GET", "/notifications")).body as Page;
    expect(first.items).toHaveLength(50);
    expect(first.next_cursor).toBeTruthy();
    const second = (await h.call(cookie, "GET", `/notifications?cursor=${first.next_cursor}`))
      .body as Page;
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(55);
    expect(second.next_cursor).toBeUndefined();
  });

  it("runs a registered action as the approver, marks it Done, and tells the requester", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const seen: { by: string; kind: string }[] = [];
    h.notifications.actions.register("agent.share_requested", "accept", async (p, n) => {
      seen.push({ by: p.userId, kind: n.kind });
      await h.notifications.notifier.notify(
        p,
        event({
          kind: "agent.share_decided",
          objectType: "agent",
          objectId: n.objectId,
          actorId: p.userId,
          people: { requester: ana.userId },
        }),
      );
      return { result: "done" };
    });
    h.notifications.actions.register("agent.share_requested", "deny", async () => {
      throw new ActionRefused(409, "ALREADY_DECIDED", "Someone already decided this.");
    });
    const agent = randomUUID();
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "agent.share_requested",
        objectType: "agent",
        objectId: agent,
        actorId: ana.userId,
        people: { approvers: [ben.userId] },
      }),
    );
    const cookie = await h.signIn(ben);
    const [item] = ((await h.call(cookie, "GET", "/notifications")).body as Page).items;
    expect(item?.actions?.map((a) => a.id)).toEqual(["accept", "deny"]);

    const refused = await h.call(cookie, "POST", `/notifications/${item?.id}/act`, {
      action: "deny",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("ALREADY_DECIDED");
    const unknown = await h.call(cookie, "POST", `/notifications/${item?.id}/act`, {
      action: "zap",
    });
    expect(unknown.status).toBe(400);

    const acted = await h.call(cookie, "POST", `/notifications/${item?.id}/act`, {
      action: "accept",
    });
    expect(acted.status).toBe(200);
    expect(acted.body.result).toBe("done");
    expect(acted.body.notification.done_at).toBeTruthy();
    expect(seen).toEqual([{ by: ben.userId, kind: "agent.share_requested" }]);
    const counts = (await h.call(cookie, "GET", "/notifications/unread-count")).body;
    expect(counts).toEqual({ unread: 0, action_required: 0 });

    const anaCookie = await h.signIn(ana);
    const requester = (await h.call(anaCookie, "GET", "/notifications")).body as Page;
    expect(requester.items.map((i) => i.kind)).toEqual(["agent.share_decided"]);
    expect(requester.items[0]?.actor?.id).toBe(ben.userId);
  });

  it("redirects for open actions and has no handler for unregistered ones", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "agent.share_requested",
        objectType: "agent",
        actorId: ana.userId,
        people: { approvers: [ben.userId] },
      }),
    );
    const cookie = await h.signIn(ben);
    const items = ((await h.call(cookie, "GET", "/notifications")).body as Page).items;
    const task = items.find((i) => i.kind === "task.assigned");
    const share = items.find((i) => i.kind === "agent.share_requested");
    const open = await h.call(cookie, "POST", `/notifications/${task?.id}/act`, { action: "open" });
    expect(open.body).toMatchObject({ result: "redirect", url: task?.url });
    const none = await h.call(cookie, "POST", `/notifications/${share?.id}/act`, {
      action: "accept",
    });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("NO_HANDLER");
  });

  it("approves a plan from the hub through the thread's own approve, and sends needs-input to the thread", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const approved: string[] = [];
    registerThreadActions(h.notifications.actions, {
      approve: async (p, runId) => {
        approved.push(`${p.userId}:${runId}`);
        return approved.length === 1;
      },
    });
    const run = randomUUID();
    const thread = randomUUID();
    for (const kind of ["thread.run.awaiting_approval", "thread.run.needs_input"] as const) {
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind,
          // Not a real run, so use a type the hub doesn't re-check for visibility.
          objectType: "task",
          objectId: kind === "thread.run.awaiting_approval" ? run : randomUUID(),
          url: `#/t/${thread}`,
          people: { runner: ana.userId },
        }),
      );
    }
    const cookie = await h.signIn(ana);
    const items = ((await h.call(cookie, "GET", "/notifications")).body as Page).items;
    const plan = items.find((i) => i.kind === "thread.run.awaiting_approval");
    const question = items.find((i) => i.kind === "thread.run.needs_input");
    expect(plan?.action_required).toBe(true);
    const ok = await h.call(cookie, "POST", `/notifications/${plan?.id}/act`, {
      action: "approve_plan",
    });
    expect(ok.body.result).toBe("done");
    expect(approved).toEqual([`${ana.userId}:${run}`]);
    // A second click, after the plan is no longer waiting, is refused.
    const again = await h.call(cookie, "POST", `/notifications/${plan?.id}/act`, {
      action: "approve_plan",
    });
    expect(again.status).toBe(409);
    const answer = await h.call(cookie, "POST", `/notifications/${question?.id}/act`, {
      action: "answer",
    });
    expect(answer.body).toEqual(
      expect.objectContaining({ result: "redirect", url: `#/t/${thread}` }),
    );
  });

  it("keeps a locked-off category off for the person who turned it on, and audits both changes", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const anaCookie = await h.signIn(ana);
    const benCookie = await h.signIn(ben);

    const before = (await h.call(benCookie, "GET", "/notification-settings")).body;
    expect(
      before.categories.find((c: { category: string }) => c.category === "vault"),
    ).toMatchObject({
      effective: true,
      locked: false,
      mode: "action_only",
    });
    expect(before.categories.map((c: { category: string }) => c.category)).not.toContain("memory");

    expect((await h.call(benCookie, "GET", "/admin/notification-settings")).status).toBe(403);
    expect(
      (
        await h.call(benCookie, "PATCH", "/admin/notification-settings", {
          categories: [{ category: "vault", locked: true }],
        })
      ).status,
    ).toBe(403);

    const locked = await h.call(anaCookie, "PATCH", "/admin/notification-settings", {
      categories: [{ category: "vault", default: false, locked: true }],
      include_content: true,
    });
    expect(locked.status).toBe(200);
    expect(locked.body.include_content).toBe(true);
    expect(
      locked.body.categories.find((c: { category: string }) => c.category === "vault"),
    ).toEqual({
      category: "vault",
      default: false,
      locked: true,
    });

    const turnedOn = await h.call(benCookie, "PATCH", "/notification-settings", {
      categories: [{ category: "vault", value: true }],
    });
    expect(turnedOn.status).toBe(200);
    expect(
      turnedOn.body.categories.find((c: { category: string }) => c.category === "vault"),
    ).toMatchObject({
      user_value: true,
      workspace_default: false,
      locked: true,
      effective: false,
    });
    // The workspace can unlock it again, and the person's own choice then applies.
    await h.call(anaCookie, "PATCH", "/admin/notification-settings", {
      categories: [{ category: "vault", locked: false }],
    });
    const unlocked = (await h.call(benCookie, "GET", "/notification-settings")).body;
    expect(
      unlocked.categories.find((c: { category: string }) => c.category === "vault"),
    ).toMatchObject({
      effective: true,
    });

    const trail = await auditTrail(pool, ana.workspaceId);
    const adminEvents = trail.filter((e) => e.action === "workspace_notification_settings.updated");
    expect(adminEvents).toHaveLength(2);
    expect(adminEvents[0]?.details).toEqual({
      categories: ["vault"],
      include_content_changed: true,
    });
    expect(adminEvents[0]?.actor_id).toBe(ana.userId);
    const mine = trail.filter((e) => e.action === "notification_settings.updated");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.actor_id).toBe(ben.userId);
  });

  it("stores quiet hours, rejects a bad zone, and clears them", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const set = await h.call(cookie, "PATCH", "/notification-settings", {
      quiet_hours: { from: "22:00", to: "07:00", tz: "Australia/Sydney" },
      categories: [{ category: "threads", value: false, mode: "all" }],
    });
    expect(set.body.quiet_hours).toEqual({ from: "22:00", to: "07:00", tz: "Australia/Sydney" });
    expect(
      set.body.categories.find((c: { category: string }) => c.category === "threads"),
    ).toMatchObject({
      effective: false,
      mode: "all",
    });
    const bad = await h.call(cookie, "PATCH", "/notification-settings", {
      quiet_hours: { from: "22:00", to: "07:00", tz: "Mars/Olympus" },
    });
    expect(bad.status).toBe(400);
    const cleared = await h.call(cookie, "PATCH", "/notification-settings", { quiet_hours: null });
    expect(cleared.body.quiet_hours).toBeUndefined();
  });

  it("flags a notification unavailable once the thread is walled from the recipient, and skips walled recipients", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const one = async (sql: string, params: unknown[]) =>
      (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
    const matter = await one(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', 'M-1', 'Matter', 'open') returning id`,
      [ana.workspaceId],
    );
    const thread = await one(
      "insert into work.thread (workspace_id, owner_id, title, matter_id) values ($1, $2, 'Q', $3) returning id",
      [ana.workspaceId, ben.userId, matter],
    );
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "thread.shared",
        objectType: "thread",
        objectId: thread,
        actorId: ana.userId,
        matterId: matter,
        people: { recipients: [ben.userId] },
      }),
    );
    const cookie = await h.signIn(ben);
    const [item] = ((await h.call(cookie, "GET", "/notifications")).body as Page).items;
    expect(item?.available).toBe(true);
    expect(item?.url).toBe(`#/t/${thread}`);

    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [ana.workspaceId, matter, ben.userId],
    );
    const opened = await h.call(cookie, "GET", `/notifications/${item?.id}`);
    expect(opened.status).toBe(200);
    expect(opened.body.notification.available).toBe(false);
    const listed = (await h.call(cookie, "GET", "/notifications")).body as Page;
    expect(listed.items[0]?.available).toBe(false);
    // The 7-day clock has started.
    const { rows } = await pool.query(
      "select unavailable_since from notify.notification where id = $1",
      [item?.id],
    );
    expect(rows[0]?.unavailable_since).not.toBeNull();

    // Walled at emission: nothing is created for ben.
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "thread.shared",
        objectType: "thread",
        objectId: randomUUID(),
        actorId: ana.userId,
        matterId: matter,
        people: { recipients: [ben.userId] },
      }),
    );
    expect(((await h.call(cookie, "GET", "/notifications")).body as Page).items).toHaveLength(1);
  });

  it("hides what an unavailable item was, and refuses to act on it", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const one = async (sql: string, params: unknown[]) =>
      (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
    const matter = await one(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', 'M-2', 'Matter', 'open') returning id`,
      [ana.workspaceId],
    );
    const thread = await one(
      "insert into work.thread (workspace_id, owner_id, title, matter_id) values ($1, $2, 'Secret title', $3) returning id",
      [ana.workspaceId, ben.userId, matter],
    );
    await h.notifications.notifier.notify(
      principal(ana),
      event({
        kind: "thread.shared",
        objectType: "thread",
        objectId: thread,
        objectTitle: "Secret title",
        actorId: ana.userId,
        matterId: matter,
        people: { recipients: [ben.userId] },
      }),
    );
    const cookie = await h.signIn(ben);
    const [item] = ((await h.call(cookie, "GET", "/notifications")).body as Page).items;
    expect(item?.title).toContain("Secret title");
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [ana.workspaceId, matter, ben.userId],
    );
    const gone = (await h.call(cookie, "GET", `/notifications/${item?.id}`)).body.notification;
    expect(gone).toMatchObject({
      available: false,
      title: "Item no longer available",
      url: "#/unavailable",
    });
    expect(gone.body).toBeUndefined();
    expect(gone.actor).toBeUndefined();
    expect(gone.actions).toBeUndefined();
    const acted = await h.call(cookie, "POST", `/notifications/${item?.id}/act`, {
      action: "open",
    });
    expect(acted.status).toBe(409);
    expect(acted.body.code).toBe("UNAVAILABLE");
  });

  it("refuses to act twice, on archived items, on oversized payloads, and off-app redirects", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    h.notifications.actions.register("agent.share_requested", "accept", async () => ({
      result: "done",
    }));
    h.notifications.actions.register("agent.share_requested", "deny", async () => ({
      result: "redirect",
      url: "javascript:alert(1)",
    }));
    const make = async () => {
      await h.notifications.notifier.notify(
        principal(ana),
        event({
          kind: "agent.share_requested",
          objectType: "agent",
          actorId: ana.userId,
          people: { approvers: [ben.userId] },
        }),
      );
      const items = ((await h.call(cookie, "GET", "/notifications")).body as Page).items;
      return items[0] as Notification;
    };
    const cookie = await h.signIn(ben);
    const first = await make();
    const big = await h.call(cookie, "POST", `/notifications/${first.id}/act`, {
      action: "accept",
      payload: { text: "x".repeat(5000) },
    });
    expect(big.status).toBe(400);
    const array = await h.call(cookie, "POST", `/notifications/${first.id}/act`, {
      action: "accept",
      payload: [1],
    });
    expect(array.status).toBe(400);
    expect(
      (await h.call(cookie, "POST", `/notifications/${first.id}/act`, { action: "accept" })).status,
    ).toBe(200);
    const again = await h.call(cookie, "POST", `/notifications/${first.id}/act`, {
      action: "accept",
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_DONE");

    const second = await make();
    expect(second.id).not.toBe(first.id);
    const redirect = await h.call(cookie, "POST", `/notifications/${second.id}/act`, {
      action: "deny",
    });
    expect(redirect.body.url).toBe(second.url);
    await h.call(cookie, "PATCH", `/notifications/${second.id}`, { archived: true });
    const archived = await h.call(cookie, "POST", `/notifications/${second.id}/act`, {
      action: "deny",
    });
    expect(archived.status).toBe(409);
    expect(archived.body.code).toBe("ARCHIVED");
  });

  it("drops an event whose link leaves the app", async () => {
    const lines: string[] = [];
    const notifications = createNotifications(pool, { log: (line) => lines.push(line) });
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    for (const url of ["https://evil.example/x", "javascript:alert(1)", "//evil.example"]) {
      await notifications.notifier.notify(
        principal(ana),
        event({
          kind: "task.assigned",
          actorId: ana.userId,
          url,
          people: { assignee: ben.userId },
        }),
      );
    }
    expect(lines).toHaveLength(3);
    expect(
      await notifications.list(principal(ben), { tab: "all", state: "unread_read" }),
    ).toMatchObject({ items: [] });
  });

  it("returns 404 for another person's notification", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    const benCookie = await h.signIn(ben);
    const [item] = ((await h.call(benCookie, "GET", "/notifications")).body as Page).items;
    const anaCookie = await h.signIn(ana);
    expect((await h.call(anaCookie, "GET", `/notifications/${item?.id}`)).status).toBe(404);
    expect(
      (await h.call(anaCookie, "PATCH", `/notifications/${item?.id}`, { read: true })).status,
    ).toBe(404);
    expect(
      (await h.call(anaCookie, "POST", `/notifications/${item?.id}/act`, { action: "open" }))
        .status,
    ).toBe(404);
    expect((await h.call("", "GET", "/notifications")).status).toBe(401);
  });

  it("swallows notifier failures so the calling module is unaffected", async () => {
    const lines: string[] = [];
    const notifications = createNotifications(pool, { log: (line) => lines.push(line) });
    const ana = await seedMember(pool);
    const stranger = { ...principal(ana), workspaceId: randomUUID() };
    await expect(
      notifications.notifier.notify(
        stranger,
        event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: randomUUID() } }),
      ),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^notify task\.assigned failed/);
    expect(lines[0]).not.toContain("Review the indemnity");
  });

  it("purges through the worker role", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    await h.notifications.notifier.notify(
      principal(ana),
      event({ kind: "task.assigned", actorId: ana.userId, people: { assignee: ben.userId } }),
    );
    await pool.query(
      "update notify.notification set created_at = now() - interval '91 days' where user_id = $1",
      [ben.userId],
    );
    const result = await h.notifications.purge();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const cookie = await h.signIn(ben);
    expect(((await h.call(cookie, "GET", "/notifications")).body as Page).items).toEqual([]);
  });
});

describe("modules telling people", () => {
  it("tells a recipient a thread was shared with them, and not the person who shared it", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const thread = (
      await pool.query<{ id: string }>(
        "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Indemnity thread') returning id",
        [ana.workspaceId, ana.userId],
      )
    ).rows[0]?.id as string;
    const shared = await h.threadService.share(
      principal(ana),
      thread,
      { userIds: [ben.userId], link: false },
      client,
    );
    expect(shared).toEqual({ ok: true, outcomes: [{ userId: ben.userId, outcome: "created" }] });

    const benCookie = await h.signIn(ben);
    const got = ((await h.call(benCookie, "GET", "/notifications")).body as Page).items;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "thread.shared",
      category: "threads",
      object_type: "thread",
      object_id: thread,
      url: `#/t/${thread}`,
      actor: { id: ana.userId },
    });
    expect(got[0]?.title).toContain("Indemnity thread");
    const anaCookie = await h.signIn(ana);
    expect(((await h.call(anaCookie, "GET", "/notifications")).body as Page).items).toEqual([]);
  });

  it("tells newly added people a vault was shared, not those who already had it, nor the sharer", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const cal = await colleague(ana, "cal");
    const created = await h.vaults.create(principal(ana), { name: "Data room" }, client);
    if (!created.ok) throw new Error("vault not created");
    const vault = created.value.id;
    const grant = (id: string) => ({
      principal_type: "user" as const,
      principal_id: id,
      level: "view" as const,
    });

    await h.vaults.setShares(
      principal(ana),
      vault,
      { grants: [grant(ben.userId), grant(ana.userId)], workspaceView: false },
      client,
    );
    const benCookie = await h.signIn(ben);
    const first = ((await h.call(benCookie, "GET", "/notifications")).body as Page).items;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "vault.shared",
      category: "vault",
      object_id: vault,
      url: `#/vaults/${vault}`,
    });
    const anaCookie = await h.signIn(ana);
    expect(((await h.call(anaCookie, "GET", "/notifications")).body as Page).items).toEqual([]);

    // Saving again with one more person tells only that person.
    await h.call(benCookie, "POST", "/notifications/read-all");
    await h.vaults.setShares(
      principal(ana),
      vault,
      { grants: [grant(ben.userId), grant(cal.userId)], workspaceView: false },
      client,
    );
    const calCookie = await h.signIn(cal);
    expect(((await h.call(calCookie, "GET", "/notifications")).body as Page).items).toHaveLength(1);
    expect((await h.call(benCookie, "GET", "/notifications/unread-count")).body.unread).toBe(0);
  });
});
