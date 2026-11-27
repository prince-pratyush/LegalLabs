import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import type pg from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { hashPassword } from "./auth/password.js";
import { createDrafts } from "./drafts/drafts.js";
import { createChronologies } from "./facts/chronology.js";
import { createFacts } from "./facts/facts.js";
import { createSpaceModule } from "./spaces/module.js";
import { scriptedTaskRuns } from "./spaces/ports.js";
import { PASSWORD, type Seeded, seedMember, testDocuments, testThreads } from "./test-db.js";
import { createVaults } from "./vaults/vaults.js";

export interface Person extends Seeded {
  cookie: string;
}

// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field.
type Body = any;

export const LETTER =
  "The supplier delivered the goods on 3 March 2021. Zed Brown signed the receipt for Acme Ltd.";

/** The API with Spaces, vaults and fact tables, and people to use them. */
export async function factWorld(
  pool: pg.Pool,
  extra: (deps: {
    documents: ReturnType<typeof testDocuments>;
  }) => Partial<Parameters<typeof createApp>[0]> = () => ({}),
) {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: { resolve: async () => null },
    }),
    vaults: createVaults(pool, { documents, store }),
    spaces: createSpaceModule(pool, { runs: scriptedTaskRuns() }),
    facts: createFacts(pool),
    chronologies: createChronologies(pool),
    clientIp: () => "203.0.113.9",
    ...extra({ documents }),
  });

  const signIn = async (m: Seeded): Promise<Person> => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return { ...m, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };

  const call = async (who: Person, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: who.cookie,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const type = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    return {
      status: res.status,
      bytes,
      disposition: res.headers.get("content-disposition"),
      body: (text && type.includes("json") ? JSON.parse(text) : text) as Body,
    };
  };

  const ana = await signIn(await seedMember(pool));

  const person = async (
    name: string,
    permissions = ["threads.use", "spaces.create", "vaults.create"],
  ) => {
    const email = `${name}-${randomUUID().slice(0, 6)}@${ana.slug}.test`;
    const one = async (sql: string, params: unknown[]) =>
      (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
    const role = await one(
      "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
      [ana.workspaceId, `Role ${email}`, permissions],
    );
    const userId = await one(
      `insert into core."user" (workspace_id, email, name, role_id, status)
       values ($1, $2, $3, $4, 'active') returning id`,
      [ana.workspaceId, email, name, role],
    );
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [ana.workspaceId, userId, await hashPassword(PASSWORD)],
    );
    return signIn({ slug: ana.slug, email, userId, workspaceId: ana.workspaceId });
  };

  const ben = await person("ben");

  /** Files a text document in a vault, ingested as the worker would. */
  const file = async (who: Person, vaultId: string, name: string, content: string) => {
    const form = new FormData();
    form.set("file", new File([content], name));
    const res = await app.request(`/api/v1/vaults/${vaultId}/files`, {
      method: "POST",
      headers: { cookie: who.cookie },
      body: form,
    });
    const body = (await res.json()) as Body;
    if (res.status >= 300) throw new Error(`upload failed: ${JSON.stringify(body)}`);
    await documents.worker.drain(who.workspaceId);
    const { rows } = await pool.query<{ document_id: string; version_id: string }>(
      `select d.id document_id, v.id version_id from content.document d
         join content.document_version v on v.document_id = d.id
        where d.vault_id = $1 and d.name = $2`,
      [vaultId, name],
    );
    const row = rows[0];
    if (!row) throw new Error(`no version for ${name}`);
    return { documentId: row.document_id, versionId: row.version_id };
  };

  const vault = async (who: Person, name: string, matterId?: string) => {
    const res = await call(who, "POST", "/vaults", {
      name,
      ...(matterId ? { matter_id: matterId } : {}),
    });
    if (res.status >= 300) throw new Error(`no vault: ${JSON.stringify(res.body)}`);
    return (res.body.vault?.id ?? res.body.id) as string;
  };

  /** A Space of Ana's with Ben in it. */
  const space = async (name = `Room ${randomUUID().slice(0, 6)}`) => {
    const made = await call(ana, "POST", "/spaces", { name });
    const id = made.body.space.id as string;
    await call(ana, "POST", `/spaces/${id}/members`, {
      principal_type: "user",
      principal_id: ben.userId,
      role: "collaborator",
    });
    return id;
  };

  const share = async (spaceId: string, vaultId: string) => {
    const res = await call(ana, "POST", `/spaces/${spaceId}/resources`, {
      resource_type: "vault",
      resource_id: vaultId,
      access: "view",
    });
    if (res.status >= 300) throw new Error(`not shared: ${JSON.stringify(res.body)}`);
    return (res.body.resource?.id ?? res.body.id) as string;
  };

  return { app, pool, documents, store, ana, ben, person, call, file, vault, space, share };
}
