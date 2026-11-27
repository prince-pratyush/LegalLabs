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
import { createEmailChannels } from "./intake/channels.js";
import { createIntake } from "./intake/intake.js";
import { createIntakeWorker } from "./intake/worker.js";
import { createFakeEmailProvider } from "./notifications/email-port.js";
import { createHub } from "./notifications/hub.js";
import { createNotifier } from "./notifications/notify.js";
import { createRunLog } from "./runs/log.js";
import { PASSWORD, type Seeded, seedMember, testDocuments } from "./test-db.js";
import { eml, type Mail } from "./test-email.js";
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
  const channels = createEmailChannels(pool, {
    secrets: createSecretBox(randomBytes(32).toString("base64")),
  });
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
    // A fresh address for every call, so the sign-in limit never bites.
    clientIp: () => `10.${randomBytes(3).join(".")}`,
  });
  const provider = createFakeEmailProvider();
  const processor = createEmailProcessor(pool, { documents: raw, scanner: createStubScanner() });
  /** Null for the real time. */
  const clock = { at: null as Date | null };
  const worker = createIntakeWorker(pool, {
    now: () => clock.at ?? new Date(),
    gateway,
    store: documents.store,
    mail: { provider },
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

    return { admin, lawyer, spaceId, channelId, type, deliver, tick, requests, request, answer };
  };

  return { app, call, member, workspace, open, model, provider, worker, intake, channels, clock };
}
