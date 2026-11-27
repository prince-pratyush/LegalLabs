import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createStubScanner, EICAR, type Scanner, ScannerUnavailable } from "@legallabs/ingest";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSecretBox } from "../admin-models/secrets.js";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp } from "../db.js";
import { createDocuments } from "../documents/documents.js";
import { createViewer } from "../documents/viewer.js";
import { createDrafts } from "../drafts/drafts.js";
import { createEmailChannels } from "../intake/channels.js";
import { createIntake } from "../intake/intake.js";
import { createRunLog } from "../runs/log.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
} from "../test-db.js";
import { AUTHSERV, eml, type Mail } from "../test-email.js";
import { noKnowledge, noVaults } from "../threads/ports.js";
import { createThreads } from "../threads/threads.js";
import { EMAIL_LIMITS } from "./email.js";
import { createEmailProcessor, type EmailProcessorOptions } from "./processor.js";

const pool = testPool();
afterAll(() => pool.end());
afterEach(() => vi.restoreAllMocks());

// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field.
type Json = any;
type Person = Seeded & { cookie: string };

interface Channel {
  id: string;
  path: string;
  secret: string;
}

function harness(options: { secrets?: boolean } = {}) {
  const clock = { at: Date.now() };
  const documents = testDocuments(pool, { scanner: createStubScanner() });
  const raw = createDocuments(pool, { store: documents.store });
  const channels = createEmailChannels(pool, {
    ...(options.secrets === false
      ? {}
      : { secrets: createSecretBox(randomBytes(32).toString("base64")) }),
    now: () => clock.at,
  });
  const gateway = createGateway({ providers: {}, recordUsage: async () => {} });
  const log = createRunLog(pool);
  const threads = createThreads(pool, {
    gateway,
    documents,
    log,
    vaults: noVaults,
    knowledge: noKnowledge,
  });
  const ip = { value: "203.0.113.9" };
  const app = createApp({
    auth: createAuth(pool),
    documents,
    viewer: createViewer(pool, documents.store, documents),
    threads: { gateway, log, vaults: noVaults, knowledge: noKnowledge, threads },
    drafts: createDrafts(pool, { gateway }),
    intake: createIntake(pool, { documents: raw }),
    emailChannels: channels,
    clientIp: () => ip.value,
    now: () => clock.at,
  });

  const read = async (res: Response) => {
    const text = await res.text();
    let body: Json = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  };
  const call = async (who: Person, method: string, path: string, json?: unknown) =>
    read(
      await app.request(`/api/v1${path}`, {
        method,
        headers: {
          cookie: who.cookie,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      }),
    );
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const workspace = async (): Promise<Person> => {
    // Each test signs in afresh from its own address, so the sign-in limit never bites.
    ip.value = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const m = await seedMember(pool);
    return { ...m, cookie: await signIn(m) };
  };
  const member = async (ws: Person, permissions: string[]): Promise<Person> => {
    const email = `u-${randomUUID().slice(0, 8)}@${ws.slug}.test`;
    const role = await pool.query<{ id: string }>(
      "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
      [ws.workspaceId, email, permissions],
    );
    const user = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status)
       values ($1, $2, $3, 'active') returning id`,
      [ws.workspaceId, email, role.rows[0]?.id],
    );
    const userId = user.rows[0]?.id ?? "";
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [ws.workspaceId, userId, await hashPassword(PASSWORD)],
    );
    const m = { slug: ws.slug, email, userId, workspaceId: ws.workspaceId };
    return { ...m, cookie: await signIn(m) };
  };

  const config = () => ({
    name: `Legal ${randomUUID().slice(0, 6)}`,
    address: "legal@firm.test",
    authserv_id: AUTHSERV,
    allowed_domains: ["acme.example"],
  });
  const channel = async (who: Person): Promise<Channel> => {
    const res = await call(who, "POST", "/apps/intake/channels", config());
    expect(res.status).toBe(201);
    return { id: res.body.channel.id, path: res.body.channel.hook_path, secret: res.body.secret };
  };

  const sign = (secret: string, body: Buffer, at = clock.at) => {
    const timestamp = String(Math.floor(at / 1000));
    const mac = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`v0:${timestamp}:`), body]))
      .digest("hex");
    return { "x-legallabs-timestamp": timestamp, "x-legallabs-signature": `v0=${mac}` };
  };
  const post = async (
    to: Channel,
    mail: Buffer,
    headers: Record<string, string> = sign(to.secret, mail),
  ) =>
    read(
      await app.request(to.path, {
        method: "POST",
        headers: { "content-type": "message/rfc822", ...headers },
        body: new Uint8Array(mail),
      }),
    );

  const processor = (over: Partial<EmailProcessorOptions> = {}) =>
    createEmailProcessor(pool, { documents: raw, scanner: createStubScanner(), ...over });
  const drain = (ws: Person, over: Partial<EmailProcessorOptions> = {}) =>
    processor(over).tick(ws.workspaceId);

  const rows = async (ws: Person) =>
    (
      await pool.query(
        `select status, reason, raw is null emptied, attempts, request_id, attachment_count,
                size_bytes, next_attempt_at > now() waiting
           from apps.inbound_email where workspace_id = $1 order by received_at, id`,
        [ws.workspaceId],
      )
    ).rows;
  const requests = async (who: Person) =>
    (await call(who, "GET", "/apps/intake/requests")).body.requests as Json[];
  const due = (ws: Person) =>
    pool.query("update apps.inbound_email set next_attempt_at = now() where workspace_id = $1", [
      ws.workspaceId,
    ]);

  /** A channel with one message sent, processed and ready to look at. */
  const delivered = async (mail: Mail, over: Partial<EmailProcessorOptions> = {}) => {
    const admin = await workspace();
    const to = await channel(admin);
    expect((await post(to, eml(mail))).status).toBe(202);
    await drain(admin, over);
    return { admin, to };
  };

  return {
    app,
    clock,
    ip,
    documents,
    channels,
    threads,
    call,
    workspace,
    member,
    config,
    channel,
    sign,
    post,
    drain,
    rows,
    requests,
    due,
    delivered,
  };
}

describe("email intake channels", () => {
  it("shows the secret once and never again", async () => {
    const h = harness();
    const admin = await h.workspace();
    const made = await h.call(admin, "POST", "/apps/intake/channels", h.config());
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.body.channel.hook_path).toMatch(/^\/hooks\/email\/[A-Za-z0-9_-]{32}$/);
    const listed = await h.call(admin, "GET", "/apps/intake/channels");
    expect(listed.body.channels).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret);
    const stored = await pool.query("select secret_sealed from apps.intake_channel where id = $1", [
      made.body.channel.id,
    ]);
    expect(stored.rows[0]?.secret_sealed.toString("utf8")).not.toContain(made.body.secret);
    const actions = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(actions).toContain("intake.channel.created");
    expect(JSON.stringify(await auditTrail(pool, admin.workspaceId))).not.toContain(
      made.body.secret,
    );
  });

  it("is managed only with intake.manage", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const triager = await h.member(admin, ["intake.triage", "threads.use"]);
    for (const [method, path, body] of [
      ["GET", "/apps/intake/channels", undefined],
      ["POST", "/apps/intake/channels", h.config()],
      ["PATCH", `/apps/intake/channels/${to.id}`, { allowed_domains: ["evil.example"] }],
      ["POST", `/apps/intake/channels/${to.id}/rotate-secret`, {}],
    ] as const) {
      expect((await h.call(triager, method, path, body)).status).toBe(403);
    }
    const other = await h.workspace();
    expect((await h.call(other, "GET", "/apps/intake/channels")).body.channels).toEqual([]);
    expect(
      (await h.call(other, "POST", `/apps/intake/channels/${to.id}/rotate-secret`, {})).status,
    ).toBe(404);
  });

  it("refuses settings that would widen who can write", async () => {
    const h = harness();
    const admin = await h.workspace();
    for (const bad of [
      { allowed_domains: [] },
      { allowed_domains: ["*"] },
      { allowed_domains: ["*.example"] },
      { allowed_domains: ["example"] },
      { authserv_id: "" },
      { authserv_id: "mx; dmarc=pass" },
    ]) {
      const res = await h.call(admin, "POST", "/apps/intake/channels", { ...h.config(), ...bad });
      expect(res.status).toBe(400);
    }
  });

  it("needs the secrets key", async () => {
    const h = harness({ secrets: false });
    const admin = await h.workspace();
    const res = await h.call(admin, "POST", "/apps/intake/channels", h.config());
    expect(res.status).toBe(503);
  });

  it("rotates with an overlap, or at once", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const rotate = (grace_hours?: number) =>
      h.call(admin, "POST", `/apps/intake/channels/${to.id}/rotate-secret`, { grace_hours });
    const next = (await rotate()).body.secret as string;
    expect(next).not.toBe(to.secret);
    expect((await h.post(to, eml())).status).toBe(202);
    expect((await h.post({ ...to, secret: next }, eml())).status).toBe(202);
    h.clock.at += 25 * 3_600_000;
    expect((await h.post(to, eml())).status).toBe(401);
    expect((await h.post({ ...to, secret: next }, eml())).status).toBe(202);

    const last = (await rotate(0)).body.secret as string;
    expect((await h.post({ ...to, secret: next }, eml())).status).toBe(401);
    expect((await h.post({ ...to, secret: last }, eml())).status).toBe(202);
  });
});

describe("the email hook", () => {
  it("accepts a signed message without a session and queues it", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const mail = eml();
    const res = await h.post(to, mail);
    expect(res.status).toBe(202);
    expect(await h.rows(admin)).toMatchObject([
      { status: "queued", emptied: false, size_bytes: mail.length },
    ]);
    expect(await h.requests(admin)).toEqual([]);
  });

  it("answers every unauthenticated call the same way and stores nothing", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const mail = eml();
    const good = h.sign(to.secret, mail);
    const answers = [
      await h.post({ ...to, path: `/hooks/email/${"a".repeat(32)}` }, mail),
      await h.post(to, mail, {}),
      await h.post(to, mail, { ...good, "x-legallabs-signature": `v0=${"0".repeat(64)}` }),
      await h.post(to, mail, h.sign("another secret", mail)),
      await h.post(to, Buffer.concat([mail, Buffer.from("tampered")]), good),
      await h.post(to, mail, h.sign(to.secret, mail, h.clock.at - 6 * 60_000)),
      await h.post(to, mail, h.sign(to.secret, mail, h.clock.at + 6 * 60_000)),
    ];
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(answers[0]?.body);
    }
    expect(await h.rows(admin)).toEqual([]);
  });

  it("takes a repeated message once, for good", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const mail = eml();
    expect((await h.post(to, mail)).status).toBe(202);
    expect((await h.post(to, mail)).status).toBe(202);
    await h.drain(admin);
    h.clock.at += 3_600_000;
    expect((await h.post(to, mail)).status).toBe(202);
    await h.drain(admin);
    expect(await h.rows(admin)).toHaveLength(1);
    expect(await h.requests(admin)).toHaveLength(1);
  });

  it("stops reading a body past the cap, whatever its length header says", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const headers = h.sign(to.secret, Buffer.from("x"));
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await h.app.request(to.path, {
      method: "POST",
      headers,
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(EMAIL_LIMITS.bytes + 4 * chunk.length);

    const declared = await h.app.request(to.path, {
      method: "POST",
      headers: { ...headers, "content-length": String(EMAIL_LIMITS.bytes + 1) },
      body: new Uint8Array(1),
    });
    expect(declared.status).toBe(413);
    expect(await h.rows(admin)).toEqual([]);
  });

  it("does not read the body of a caller it does not know", async () => {
    const h = harness();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const res = await h.app.request(`/hooks/email/${"b".repeat(32)}`, {
      method: "POST",
      headers: h.sign("x", Buffer.from("x")),
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(401);
    expect(pulled).toBe(0);
  });

  it("limits each address, and each channel", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    const statuses = [];
    for (let i = 0; i < 130; i++) {
      statuses.push((await h.post(to, eml(), {})).status);
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(120);
    expect(statuses.at(-1)).toBe(429);

    // The address is spent, the channel is not.
    h.ip.value = "192.0.2.7";
    const mail = eml();
    expect((await h.post(to, mail)).status).toBe(202);
    for (let i = 0; i < 119; i++) await h.post(to, mail);
    h.ip.value = "192.0.2.8";
    const over = await h.post(to, eml());
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("takes nothing for a disabled channel, and drops what was waiting", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    expect((await h.post(to, eml())).status).toBe(202);
    const off = await h.call(admin, "PATCH", `/apps/intake/channels/${to.id}`, {
      status: "disabled",
    });
    expect(off.status).toBe(200);
    expect((await h.post(to, eml())).status).toBe(401);
    expect(await h.rows(admin)).toMatchObject([
      { status: "rejected", reason: "channel_disabled", emptied: true },
    ]);
  });

  it("refuses, for the sender to retry, once too much is waiting", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await pool.query(
      `insert into apps.inbound_email (workspace_id, channel_id, event_hash, size_bytes, status, raw)
       select $1, $2, sha256(i::text::bytea), 1, 'queued', 'x' from generate_series(1, 500) i`,
      [admin.workspaceId, to.id],
    );
    const res = await h.post(to, eml());
    expect(res.status).toBe(429);
    expect(await h.rows(admin)).toHaveLength(500);
  });
});

describe("processing the queue", () => {
  it("makes a request from the message and files its parts in the Inbox", async () => {
    const h = harness();
    const { admin } = await h.delivered({
      parts: [{ name: "nda.txt", type: "text/plain", content: "Mutual NDA text" }],
    });
    expect(await h.rows(admin)).toMatchObject([
      { status: "accepted", emptied: true, attachment_count: 1 },
    ]);
    const [request] = await h.requests(admin);
    expect(request).toMatchObject({
      channel: "email",
      status: "unclassified",
      type_id: null,
      assignee_id: null,
      matter_id: null,
      requester: { display_name: "Jo Smith", email: "jo@acme.example" },
    });
    const detail = (await h.call(admin, "GET", `/apps/intake/requests/${request.id}`)).body.request;
    expect(detail.attachments.map((a: Json) => a.name).sort()).toEqual([
      "Email message.txt",
      "nda.txt",
    ]);
    // Read by the ingest worker, which is also where each file is scanned again.
    await h.documents.worker.drain(admin.workspaceId);
    const body = await pool.query(
      `select p.text from content.page p
         join content.document_version v on v.id = p.version_id
         join content.document d on d.id = v.document_id
        where d.workspace_id = $1 and d.name = 'Email message.txt'`,
      [admin.workspaceId],
    );
    expect(body.rows[0]?.text).toContain("Please review the attached NDA");
    expect(body.rows[0]?.text).toContain("NDA with Acme");

    const events = (await h.call(admin, "GET", `/apps/intake/requests/${request.id}/audit`)).body
      .events;
    expect(events).toMatchObject([{ kind: "inbound", actor_type: "requester", actor_id: null }]);
    const trail = await auditTrail(pool, admin.workspaceId);
    expect(trail.map((e) => e.action)).toContain("intake.request.created");
    for (const secret of ["jo@acme.example", "Jo Smith", "NDA with Acme", "nda.txt", "Friday"]) {
      expect(JSON.stringify(trail)).not.toContain(secret);
    }
  });

  it("gives the sender's address no identity or permission", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await pool.query(`update core."user" set email = 'jo@acme.example' where id = $1`, [
      admin.userId,
    ]);
    await h.post(to, eml());
    await h.drain(admin);
    const row = await pool.query(
      "select created_by, assignee_id, matter_id from apps.intake_request where workspace_id = $1",
      [admin.workspaceId],
    );
    expect(row.rows).toEqual([{ created_by: null, assignee_id: null, matter_id: null }]);
    const used = await pool.query(
      "select count(*) n from admin.audit_event where workspace_id = $1 and actor_id = $2 and action like 'intake.request%'",
      [admin.workspaceId, admin.userId],
    );
    expect(used.rows[0]?.n).toBe("0");
  });

  it("keeps the files from every other kind of work", async () => {
    const h = harness();
    const { admin } = await h.delivered({
      parts: [{ name: "terms.txt", content: "zanzibar indemnity" }],
    });
    await h.documents.worker.drain(admin.workspaceId);
    const [request] = await h.requests(admin);
    const detail = (await h.call(admin, "GET", `/apps/intake/requests/${request.id}`)).body.request;
    const me = { userId: admin.userId, workspaceId: admin.workspaceId };
    const seen = await asApp(pool, me, (db) =>
      db.query("select id from content.document where id = any($1)", [
        detail.attachments.map((a: Json) => a.document_id),
      ]),
    );
    expect(seen.rows).toEqual([]);
    const hits = await h.documents.search({ ...me, sessionId: "s" }, "zanzibar");
    expect(hits).toEqual([]);
  });

  it.each<[string, Mail, string]>([
    ["a failed DMARC check", { auth: `${AUTHSERV}; dmarc=fail header.from=acme.example` }, "dmarc"],
    ["an unknown domain", { from: "x@evil.example" }, "domain"],
    ["an auto reply", { headers: ["Auto-Submitted: auto-replied"] }, "auto_submitted"],
  ])("drops %s, keeps nothing of it and audits why", async (_, mail, reason) => {
    const h = harness();
    const { admin } = await h.delivered(mail);
    expect(await h.rows(admin)).toMatchObject([{ status: "rejected", reason, emptied: true }]);
    expect(await h.requests(admin)).toEqual([]);
    const trail = await auditTrail(pool, admin.workspaceId);
    const rejected = trail.filter((e) => e.action === "email.inbound_rejected");
    expect(rejected.map((e) => e.details)).toEqual([{ reason }]);
    const files = await pool.query(
      "select count(*) n from content.document where workspace_id = $1",
      [admin.workspaceId],
    );
    expect(files.rows[0]?.n).toBe("0");
  });

  it("takes one Message-ID from one sender once", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await h.post(to, eml({ messageId: "<same@acme.example>", body: "one" }));
    await h.post(to, eml({ messageId: "<same@acme.example>", body: "two" }));
    // Someone else cannot take the id first.
    await h.post(to, eml({ messageId: "<same@acme.example>", from: "eve@acme.example" }));
    await h.drain(admin);
    expect(await h.requests(admin)).toHaveLength(2);
    expect((await h.rows(admin)).map((r) => r.reason).sort()).toEqual(["duplicate", null, null]);
  });

  it("drops infected and unreadable files, and says so in the message", async () => {
    const h = harness();
    const { admin } = await h.delivered({
      parts: [
        { name: "virus.txt", content: EICAR },
        { name: "tool.exe", content: "MZ..." },
        { name: "ok.txt", content: "fine" },
      ],
    });
    const [request] = await h.requests(admin);
    const detail = (await h.call(admin, "GET", `/apps/intake/requests/${request.id}`)).body.request;
    expect(detail.attachments.map((a: Json) => a.name).sort()).toEqual([
      "Email message.txt",
      "ok.txt",
    ]);
    await h.documents.worker.drain(admin.workspaceId);
    const { rows } = await pool.query<{ text: string }>(
      `select string_agg(p.text, ' ') as text from content.page p
         join content.document_version v on v.id = p.version_id
         join content.document d on d.id = v.document_id
        where d.workspace_id = $1 and d.name = 'Email message.txt'`,
      [admin.workspaceId],
    );
    expect(rows[0]?.text).toContain("virus.txt (failed the malware scan)");
    expect(rows[0]?.text).toContain("tool.exe (not a type that can be read)");
  });

  it("waits while the scanner is down, then carries on", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await h.post(to, eml({ parts: [{ name: "a.txt", content: "a" }] }));
    const down: Scanner = {
      scan: async () => {
        throw new ScannerUnavailable("down");
      },
    };
    await h.drain(admin, { scanner: down });
    expect(await h.rows(admin)).toMatchObject([
      { status: "queued", emptied: false, attempts: 0, waiting: true },
    ]);
    expect(await h.requests(admin)).toEqual([]);
    await h.due(admin);
    await h.drain(admin);
    expect(await h.requests(admin)).toHaveLength(1);
  });

  it("files nothing twice when a pass is cut off", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await h.post(
      to,
      eml({
        parts: [
          { name: "a.txt", content: "a" },
          { name: "b.txt", content: "b" },
        ],
      }),
    );
    const real = createDocuments(pool, { store: h.documents.store });
    let uploads = 0;
    await h.drain(admin, {
      documents: {
        upload: (...args) => {
          if (++uploads === 2) throw new Error("connection lost: SECRET CONTENT");
          return real.upload(...args);
        },
      },
    });
    // The one filed is held back from everyone until its request exists.
    expect(await h.requests(admin)).toEqual([]);
    await h.due(admin);
    await h.drain(admin);
    const [request] = await h.requests(admin);
    const detail = (await h.call(admin, "GET", `/apps/intake/requests/${request.id}`)).body.request;
    expect(detail.attachments.map((a: Json) => a.name).sort()).toEqual([
      "Email message.txt",
      "a.txt",
      "b.txt",
    ]);
    const files = await pool.query(
      "select count(*) n from content.document where workspace_id = $1",
      [admin.workspaceId],
    );
    expect(files.rows[0]?.n).toBe("3");
  });

  it("gives up after its attempts and keeps no content", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await h.post(to, eml());
    const broken = {
      documents: {
        upload: async () => {
          throw new Error("broken");
        },
      },
      maxAttempts: 2,
    };
    await h.drain(admin, broken);
    await h.due(admin);
    await h.drain(admin, broken);
    await h.due(admin);
    await h.drain(admin, broken);
    expect(await h.rows(admin)).toMatchObject([{ status: "failed", emptied: true, attempts: 2 }]);
    const trail = await auditTrail(pool, admin.workspaceId);
    expect(trail.map((e) => e.action)).toContain("email.inbound_failed");
  });

  it("queues what is over the hourly rate rather than dropping it", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    for (let i = 0; i < 3; i++) await h.post(to, eml());
    await h.drain(admin, { perHour: 2 });
    expect((await h.rows(admin)).map((r) => r.status)).toEqual(["accepted", "accepted", "queued"]);
    await pool.query(
      "update apps.inbound_email set processed_at = now() - interval '2 hours' where workspace_id = $1 and processed_at is not null",
      [admin.workspaceId],
    );
    await h.drain(admin, { perHour: 2 });
    expect(await h.requests(admin)).toHaveLength(3);
  });

  it("holds back one busy sender without holding back others", async () => {
    const h = harness();
    const admin = await h.workspace();
    const to = await h.channel(admin);
    for (let i = 0; i < 3; i++) await h.post(to, eml());
    await h.post(to, eml({ from: "other@acme.example" }));
    await h.drain(admin, { senderPerHour: 2 });
    const rows = await h.rows(admin);
    expect(rows.map((r) => r.status)).toEqual(["accepted", "accepted", "queued", "accepted"]);
    expect(rows[2]).toMatchObject({ waiting: true, attempts: 0, emptied: false });
  });

  it("writes no address or content to the log", async () => {
    const h = harness();
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void lines.push(args.join(" ")));
    }
    const admin = await h.workspace();
    const to = await h.channel(admin);
    await h.post(to, eml());
    await h.post(to, eml({ from: "x@evil.example" }));
    await h.post(to, eml(), h.sign("wrong", Buffer.from("x")));
    const log = (line: string) => void lines.push(line);
    await h.drain(admin, {
      log,
      documents: {
        upload: async () => {
          throw new Error("jo@acme.example: NDA with Acme, Friday");
        },
      },
    });
    await h.due(admin);
    await h.drain(admin, { log });
    const said = lines.join("\n");
    expect(said).not.toMatch(/acme\.example|evil\.example|NDA|Friday|Jo Smith/);
    expect(said).not.toContain(to.secret);
  });
});
