import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import type pg from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { hashPassword } from "./auth/password.js";
import { createDrafts } from "./drafts/drafts.js";
import { createMatters } from "./matters/matters.js";
import { PASSWORD, type Seeded, seedMember, testDocuments, testThreads } from "./test-db.js";
import { createVaults } from "./vaults/vaults.js";

export interface Person {
  slug: string;
  email: string;
  userId: string;
  workspaceId: string;
  cookie: string;
}

/** The whole API over HTTP, with matters, vaults, documents and threads mounted. */
export function matterHarness(pool: pg.Pool) {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const vaults = createVaults(pool, { documents, store });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    vaults,
    matters: createMatters(pool),
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

  // biome-ignore lint/suspicious/noExplicitAny: tests read loosely typed JSON bodies.
  type Body = any;
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
    let body: Body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  const postFile = async (
    who: Person,
    path: string,
    name: string,
    content: string,
    extra: Record<string, string> = {},
  ) => {
    const form = new FormData();
    form.set("file", new File([content], name));
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    const res = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { cookie: who.cookie },
      body: form,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  };

  /** A workspace whose first member holds every permission. */
  const workspace = async (): Promise<Person> => {
    const admin = await seedMember(pool);
    return { ...admin, cookie: await signIn(admin) };
  };

  /** Another member of the workspace, with only the everyday permissions. */
  const member = async (ws: Person, name: string): Promise<Person> => {
    const email = `${name}-${randomUUID().slice(0, 6)}@${ws.slug}.test`;
    const role = await pool.query<{ id: string }>(
      `insert into core.role (workspace_id, name, permissions)
       values ($1, $2, '{threads.use,vaults.create}') returning id`,
      [ws.workspaceId, `User ${email}`],
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
    const person = { slug: ws.slug, email, userId, workspaceId: ws.workspaceId };
    return { ...person, cookie: await signIn(person) };
  };

  /** Groups have no API yet, so they are written as the directory sync would. */
  const group = async (ws: Person, name: string, members: Person[]) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into core."group" (workspace_id, name) values ($1, $2) returning id`,
      [ws.workspaceId, name],
    );
    const id = rows[0]?.id ?? "";
    for (const m of members) {
      await pool.query(
        "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
        [ws.workspaceId, id, m.userId],
      );
    }
    return id;
  };

  const drain = (ws: Person) => documents.worker.drain(ws.workspaceId);

  return { app, call, postFile, workspace, member, group, drain, documents };
}
