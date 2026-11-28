import { randomBytes, randomUUID } from "node:crypto";
import { createStubScanner } from "@legallabs/ingest";
import { createGateway } from "@legallabs/model-gateway";
import type pg from "pg";
import { expect } from "vitest";
import { createSecretBox } from "./admin-models/secrets.js";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { hashPassword } from "./auth/password.js";
import { createDocuments } from "./documents/documents.js";
import { createViewer } from "./documents/viewer.js";
import { createDrafts } from "./drafts/drafts.js";
import { senderHash } from "./inbound/email.js";
import { createEmailProcessor } from "./inbound/processor.js";
import { createSlackProcessor } from "./inbound/slack-processor.js";
import { createEmailChannels } from "./intake/channels.js";
import { createIntake } from "./intake/intake.js";
import type { Posted, SlackApi } from "./intake/slack-api.js";
import { createSlackChannels } from "./intake/slack-channels.js";
import { createIntakeWorker } from "./intake/worker.js";
import { createFakeEmailProvider } from "./notifications/email-port.js";
import { createHub } from "./notifications/hub.js";
import { createNotifier } from "./notifications/notify.js";
import { createRunLog } from "./runs/log.js";
import { PASSWORD, type Seeded, seedMember, testDocuments } from "./test-db.js";
import { eml, type Mail } from "./test-email.js";
import { INTAKE_CHANNEL, SIGNING_SECRET, signed, TEAM } from "./test-slack.js";
import { noKnowledge, noVaults } from "./threads/ports.js";
import { createThreads } from "./threads/threads.js";

// An intake desk for tests: a workspace with an address, a Space, a request type routed to a
// lawyer there, a model that says what the test tells it to, and mail that stays in memory.

// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field.
type Json = any;
export type Person = Seeded & { cookie: string };

export function intakeDesk(pool: pg.Pool) {
  const documents = testDocuments(pool, { scanner: createStubScanner() });
  const raw = createDocuments(pool, { store: documents.store });
  const secrets = createSecretBox(randomBytes(32).toString("base64"));
  const channels = createEmailChannels(pool, { secrets });
  const slackChannels = createSlackChannels(pool, { secrets });
  const model = { answer: null as unknown, calls: [] as string[] };
  const gateway = createGateway({
    providers: {
      anthropic: {
        async complete({ messages }) {
          model.calls.push(messages.map((m) => m.content).join("\n"));
          return { text: JSON.stringify(model.answer) };
        },
      },
    },
    recordUsage: async () => {},
  });
  const log = createRunLog(pool);
  const threads = createThreads(pool, {
    gateway,
    documents,
    log,
    vaults: noVaults,
    knowledge: noKnowledge,
  });
  const notifier = createNotifier(pool, createHub(), () => {});
  const intake = createIntake(pool, { documents: raw, notifier });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    viewer: createViewer(pool, documents.store, documents),
    threads: { gateway, log, vaults: noVaults, knowledge: noKnowledge, threads },
    drafts: createDrafts(pool, { gateway }),
    intake,
    emailChannels: channels,
    slackChannels,
    // A fresh address for every call, so the sign-in limit never bites.
    clientIp: () => `10.${randomBytes(3).join(".")}`,
  });
  const provider = createFakeEmailProvider();
  /** Slack as the tests see it: what was posted, and the files it will hand out. */
  const slack = {
    posted: [] as { token: string; channel: string; threadTs: string | null; text: string }[],
    fetched: [] as string[],
    files: new Map<string, Buffer>(),
    /** What the next posts answer, before posting works again. */
    refuse: [] as Posted[],
  };
  const slackApi: SlackApi = {
    async post(token, message) {
      const refused = slack.refuse.shift();
      if (refused) return refused;
      slack.posted.push({ token, ...message });
      const channel = /^[UW]/.test(message.channel)
        ? `D${message.channel.slice(1)}`
        : message.channel;
      return {
        ok: true,
        channel,
        ts: `1800000099.${String(slack.posted.length).padStart(6, "0")}`,
      };
    },
    async download(_token, file, maxBytes) {
      slack.fetched.push(file.url);
      const bytes = slack.files.get(file.url);
      return bytes && bytes.length <= maxBytes
        ? { ok: true, bytes }
        : { ok: false, why: "not fetched" };
    },
  };
  const slackProcessor = createSlackProcessor(pool, {
    documents: raw,
    scanner: createStubScanner(),
    secrets,
    api: slackApi,
  });
  const processor = createEmailProcessor(pool, { documents: raw, scanner: createStubScanner() });
  /** Null for the real time. */
  const clock = { at: null as Date | null };
  const worker = createIntakeWorker(pool, {
    now: () => clock.at ?? new Date(),
    gateway,
    store: documents.store,
    mail: { provider },
    slack: { api: slackApi, secrets },
    notifier,
  });

  const call = async (who: Person, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: who.cookie,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const workspace = async (): Promise<Person> => {
    const m = await seedMember(pool);
    return { ...m, cookie: await signIn(m) };
  };
  const member = async (ws: Person, permissions: string[], name = ""): Promise<Person> => {
    const email = `u-${randomUUID().slice(0, 8)}@${ws.slug}.test`;
    const role = await pool.query<{ id: string }>(
      "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
      [ws.workspaceId, email, permissions],
    );
    const user = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, name, role_id, status)
       values ($1, $2, $3, $4, 'active') returning id`,
      [ws.workspaceId, email, name, role.rows[0]?.id],
    );
    const userId = user.rows[0]?.id ?? "";
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [ws.workspaceId, userId, await hashPassword(PASSWORD)],
    );
    const m = { slug: ws.slug, email, userId, workspaceId: ws.workspaceId };
    return { ...m, cookie: await signIn(m) };
  };

  const open = async () => {
    const admin = await workspace();
    const lawyer = await member(admin, ["intake.triage", "threads.use"], "Lee Law");
    const space = await pool.query<{ id: string }>(
      "insert into work.space (workspace_id, name, created_by) values ($1, 'Intake', $2) returning id",
      [admin.workspaceId, admin.userId],
    );
    const spaceId = space.rows[0]?.id ?? "";
    await pool.query(
      `insert into work.space_member (workspace_id, space_id, principal_type, principal_id, role, invited_by)
       values ($1, $2, 'user', $3, 'collaborator', $4)`,
      [admin.workspaceId, spaceId, lawyer.userId, admin.userId],
    );
    const made = await call(admin, "POST", "/apps/intake/channels", {
      name: "Legal",
      address: "legal@firm.test",
      authserv_id: "mx.firm.test",
      allowed_domains: ["acme.example"],
    });
    expect(made.status).toBe(201);
    const channelId = made.body.channel.id as string;

    const type = async (over: Record<string, unknown> = {}) => {
      const res = await call(admin, "POST", "/apps/intake/request-types", {
        name: "NDA",
        sla_hours: 8,
        keyword_rules: ["nda"],
        fields: [
          {
            key: "counterparty",
            label: "Counterparty",
            type: "text",
            required: true,
            prompt: "What is the counterparty's registered name?",
          },
          { key: "mutual", label: "Mutual", type: "boolean", required: true },
        ],
        routing: {
          kind: "lawyer",
          space_id: spaceId,
          assignment: [{ kind: "fixed", user_id: lawyer.userId }],
        },
        ...over,
      });
      expect(res.status).toBe(201);
      return res.body.type.id as string;
    };

    /** Mail arrives, as past the hook's checks, and everything due is done. */
    const deliver = async (mail: Mail) => {
      await channels.receive(channelId, eml(mail), {
        fromHash: senderHash(admin.workspaceId, "jo@acme.example"),
      });
      await processor.tick(admin.workspaceId);
      await worker.tick(admin.workspaceId);
    };
    const tick = () => worker.tick(admin.workspaceId);
    const requests = async () =>
      (await call(admin, "GET", "/apps/intake/requests?sort=created_at")).body.requests as Json[];
    const request = async () => (await requests()).at(-1) as Json;
    /** Answers the newest mail we sent. */
    const answer = (body: string, over: Mail = {}) =>
      deliver({
        subject: "Re: your question",
        body,
        headers: [`In-Reply-To: ${provider.sent.at(-1)?.messageId}`],
        ...over,
      });

    /** A Slack channel of this workspace, and a way to post to it as Slack would. */
    const slackChannel = async (over: Record<string, unknown> = {}) => {
      const res = await call(admin, "POST", "/apps/intake/slack-channels", {
        name: "Slack",
        team_id: TEAM,
        channel_ids: [INTAKE_CHANNEL],
        signing_secret: SIGNING_SECRET,
        bot_token: "xoxb-test-token-0000",
        ...over,
      });
      expect(res.status).toBe(201);
      const { id, hook_path: path } = res.body.channel as { id: string; hook_path: string };
      const send = async (body: unknown, headers: Record<string, string> = {}) => {
        const text = typeof body === "string" ? body : JSON.stringify(body);
        const sent = await app.request(path, {
          method: "POST",
          headers: { ...signed(text, Date.now()), ...headers },
          body: text,
        });
        const answered = await sent.text();
        return {
          status: sent.status,
          retryAfter: sent.headers.get("retry-after"),
          body: (answered ? JSON.parse(answered) : null) as Json,
        };
      };
      /** What was queued is read, and everything due is done. */
      const run = async () => {
        await slackProcessor.tick(admin.workspaceId);
        // Each tick posts the oldest message of each request.
        await worker.tick(admin.workspaceId);
        await worker.tick(admin.workspaceId);
      };
      const receive = async (body: unknown) => {
        const sent = await send(body);
        expect(sent.status).toBe(200);
        await run();
        return sent;
      };
      return { id, path, send, run, receive };
    };

    return {
      admin,
      lawyer,
      spaceId,
      channelId,
      type,
      deliver,
      tick,
      requests,
      request,
      answer,
      slackChannel,
    };
  };

  return {
    app,
    call,
    member,
    workspace,
    open,
    model,
    provider,
    worker,
    intake,
    channels,
    clock,
    slack,
    slackProcessor,
    slackChannels,
    secrets,
  };
}
