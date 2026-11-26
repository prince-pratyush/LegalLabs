import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createAgents } from "../agents/agents.js";
import { createContextPort } from "../agents/context.js";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp } from "../db.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { recordingGuestMailer } from "./guests.js";
import { createSpaceModule } from "./module.js";
import { scriptedTaskRuns } from "./ports.js";

/*
 * Agents shared into Spaces, with the real catalogue: who may share, what waits for a Space
 * admin, what a guest gets, and the walls of the matters an agent's files belong to.
 */

const pool = testPool();
afterAll(() => pool.end());

const CLIENT = { ip: null, userAgent: null };
const GUEST = "lead@other.test";
const SECRET = "Our walk-away price is nine million.";

const one = async (sql: string, params: unknown[]) =>
  (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";

async function person(m: Seeded, permissions: string[]): Promise<Seeded> {
  const email = `p-${randomUUID().slice(0, 8)}@${m.slug}.test`;
  const role = await one(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `Role ${email}`, permissions],
  );
  const userId = await one(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role],
  );
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

const SHARER = ["threads.use", "spaces.create", "spaces.external", "agents.use", "agents.build"];

type Reply = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field
  body: any;
  cookie: string;
};

async function world() {
  const ana = await seedMember(pool);
  const cal = await person(ana, SHARER);
  const mailer = recordingGuestMailer();
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const agents = createAgents(pool, { attachments: createContextPort(pool), documents });
  const spaces = createSpaceModule(pool, {
    runs: scriptedTaskRuns(),
    guest: { mailer },
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: { resolve: async () => null },
    }),
    spaces,
    clientIp: () => "203.0.113.9",
  });
  const send = async (
    url: string,
    cookie: string,
    method: string,
    json?: unknown,
  ): Promise<Reply> => {
    const res = await app.request(url, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return {
      status: res.status,
      body: text && type.includes("json") ? JSON.parse(text) : text,
      cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    };
  };
  const signIn = async (m: Seeded) => {
    const login = await send("/auth/login", "", "POST", {
      workspace: m.slug,
      email: m.email,
      password: PASSWORD,
    });
    return (method: string, path: string, json?: unknown) =>
      send(`/api/v1${path}`, login.cookie, method, json);
  };
  const principal = (m: Seeded) => ({
    sessionId: randomUUID(),
    userId: m.userId,
    workspaceId: m.workspaceId,
  });
  /** A saved agent of someone's, with a secret in its instructions. */
  const agent = async (owner: Seeded, vaultId?: string) => {
    const made = await agents.create(
      principal(owner),
      { title: "Diligence", mode: "scratch" },
      CLIENT,
    );
    if (!made.ok) throw new Error(made.code);
    const saved = await agents.saveVersion(
      principal(owner),
      made.agent.id,
      {
        instructions: SECRET,
        attachments: vaultId ? [{ label: "room", kind: "vault", ref: vaultId, name: "Room" }] : [],
        sources: [],
        promote: true,
      },
      CLIENT,
    );
    if (!saved.ok) throw new Error(saved.code);
    return made.agent.id;
  };
  return {
    ana,
    cal,
    mailer,
    agents,
    spaces,
    agent,
    principal,
    a: await signIn(ana),
    c: await signIn(cal),
    pub: (method: string, path: string, json?: unknown) => send(`/guest${path}`, "", method, json),
    asGuest: (cookie: string) => (method: string, path: string, json?: unknown) =>
      send(`/api/v1${path}`, cookie, method, json),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** A Space of Ana's with Cal collaborating in it. */
async function room(w: World, kind: "internal" | "external", matterId?: string) {
  const made = await w.a("POST", "/spaces", {
    name: `Deal ${randomUUID().slice(0, 6)}`,
    kind,
    ...(matterId ? { matter_id: matterId } : {}),
  });
  expect(made.status).toBe(201);
  const id: string = made.body.space.id;
  await w.a("POST", `/spaces/${id}/members`, {
    principal_type: "user",
    principal_id: w.cal.userId,
    role: "collaborator",
  });
  return id;
}

const share = (as: World["a"], space: string, agent: string, extra: object = {}) =>
  as("POST", `/spaces/${space}/resources`, {
    resource_type: "agent",
    resource_id: agent,
    access: "run",
    ...extra,
  });

/** Adds a party, brings its guest in and approves the connection from both sides. */
async function guestIn(w: World, space: string) {
  const added = await w.a("POST", `/spaces/${space}/parties`, {
    name: "Other LLP",
    domain: "other.test",
    connection_admin_emails: [GUEST],
  });
  const party: string = added.body.party.id;
  const invited = await w.a("POST", `/spaces/${space}/guests`, { email: GUEST });
  const accepted = await w.pub("POST", "/invites/accept", {
    token: invited.body.token,
    name: "Lee",
  });
  const workspace: string = accepted.body.workspace;
  await w.pub("POST", "/login/code", { workspace, email: GUEST });
  const verified = await w.pub("POST", "/login/verify", {
    workspace,
    email: GUEST,
    code: w.mailer.sent.at(-1)?.code,
  });
  const g = w.asGuest(verified.cookie);
  await w.a("POST", `/spaces/${space}/parties/${party}/approve`);
  await g("POST", `/guest/spaces/${space}/connection/approve`);
  const userId = await one(`select id from core."user" where workspace_id = $1 and email = $2`, [
    w.ana.workspaceId,
    GUEST,
  ]);
  const me = { sessionId: randomUUID(), userId, workspaceId: w.ana.workspaceId };
  return { party, g, me };
}

describe("agents in an internal Space", () => {
  it("is shared at once, runs for members, and shows them no instructions", async () => {
    const w = await world();
    const space = await room(w, "internal");
    const agent = await w.agent(w.ana);
    expect((await share(w.a, space, agent)).status).toBe(201);

    const mine = await w.agents.get(w.principal(w.cal), agent);
    expect(mine?.agent.my_access).toBe("run");
    expect(await w.agents.versions(w.principal(w.cal), agent)).toEqual([]);
    const task = await w.c("POST", `/spaces/${space}/tasks`, {
      name: "Check it",
      assignee: { type: "agent", agent_id: agent },
    });
    expect(task.status).toBe(201);
  });

  it("is never shared at Full, and only by someone with Full of their own", async () => {
    const w = await world();
    const space = await room(w, "internal");
    const agent = await w.agent(w.ana);
    expect((await share(w.a, space, agent, { access: "full" })).body.code).toBe("INVALID");
    const added = await share(w.a, space, agent);
    // Run through the Space is not enough to hand it on.
    const other = await room(w, "internal");
    expect((await share(w.c, other, agent)).status).toBe(403);
    // Nor may a Space admin without Full widen it to reading the instructions.
    await w.a("POST", `/spaces/${space}/members`, {
      principal_type: "user",
      principal_id: (await person(w.ana, SHARER)).userId,
      role: "admin",
    });
    const mine = await w.agent(w.cal);
    const own = await room(w, "internal");
    const theirs = await share(w.c, own, mine);
    expect(theirs.status).toBe(201);
    const widened = await w.a("PATCH", `/spaces/${own}/resources/${theirs.body.resource.id}`, {
      access: "view",
    });
    expect(widened.status).toBe(403);
    expect(added.status).toBe(201);
  });

  it("is not granted by a template the creator has no Full for", async () => {
    const w = await world();
    const agent = await w.agent(w.cal);
    // Ana can name any agent in a template; applying it must not hand her one.
    const made = await w.a("POST", "/space-templates", {
      name: "Grab",
      definition: {
        schema: "counsel.space-template/1",
        phases: [],
        agents: [{ id: agent, level: "view" }],
        workflows: [],
        vault_links: [],
        customization: {},
      },
    });
    expect(made.status).toBe(201);
    const space = await w.a("POST", "/spaces", {
      name: "From it",
      template_id: made.body.template.id,
    });
    expect(space.body.skipped).toMatchObject([{ kind: "agent", reason: "not_shared" }]);
    expect((await share(w.a, space.body.space.id, agent)).status).toBe(403);
  });
});

describe("agents in an external Space", () => {
  it("waits for a Space admin when a collaborator shares", async () => {
    const w = await world();
    const space = await room(w, "external");
    const agent = await w.agent(w.cal);

    const asked = await share(w.c, space, agent);
    expect(asked.status).toBe(202);
    expect(asked.body.request).toMatchObject({ status: "pending", access: "run" });
    expect((await w.a("GET", `/spaces/${space}/resources`)).body.resources).toEqual([]);
    expect((await share(w.c, space, agent)).body.code).toBe("ALREADY_REQUESTED");
    // The database refuses the grant too, whatever route writes it.
    await expect(
      asApp(pool, w.principal(w.cal), (db) =>
        db.query(
          `insert into work.space_resource
             (workspace_id, space_id, resource_type, resource_id, access, granted_by)
           values ($1, $2, 'agent', $3, 'run', $4)`,
          [w.cal.workspaceId, space, agent, w.cal.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const id = asked.body.request.id;
    expect(
      (await w.c("POST", `/spaces/${space}/share-requests/${id}`, { decision: "accept" })).status,
    ).toBe(403);
    const queue = await w.a("GET", `/spaces/${space}/requests`);
    expect(queue.body.shares).toMatchObject([
      { id, resource_id: agent, name: "Diligence", requested_by: w.cal.userId },
    ]);
    expect(JSON.stringify(queue.body)).not.toContain("walk-away");
    expect(
      (await w.a("POST", `/spaces/${space}/share-requests/${id}`, { decision: "accept" })).status,
    ).toBe(204);
    expect((await w.a("GET", `/spaces/${space}/resources`)).body.resources).toMatchObject([
      { resource_type: "agent", access: "run" },
    ]);
  });

  it("holds a declined share off, and refuses one whose sharer has lost the right", async () => {
    const w = await world();
    const space = await room(w, "external");
    const agent = await w.agent(w.cal);
    const first = await share(w.c, space, agent);
    await w.a("POST", `/spaces/${space}/share-requests/${first.body.request.id}`, {
      decision: "deny",
      reason: "not yet",
    });
    expect((await share(w.c, space, agent)).body.code).toBe("SHARE_REQUEST_COOLDOWN");

    const other = await w.agent(w.cal);
    const asked = await share(w.c, space, other);
    await pool.query("update core.role set permissions = $2 where name = $1", [
      `Role ${w.cal.email}`,
      ["threads.use", "agents.use"],
    ]);
    const late = await w.a("POST", `/spaces/${space}/share-requests/${asked.body.request.id}`, {
      decision: "accept",
    });
    expect(late.body.code).toBe("SHARE_REQUEST_STALE");
    expect((await w.a("GET", `/spaces/${space}/resources`)).body.resources).toEqual([]);
  });

  it("gives a guest party Run and the title, never the instructions", async () => {
    const w = await world();
    const space = await room(w, "external");
    const { party, g, me } = await guestIn(w, space);
    const agent = await w.agent(w.ana);
    for (const level of ["view", "edit", "full"]) {
      const refused = await share(w.a, space, agent, { per_party: { [party]: level } });
      expect(refused.body.code, level).toBe("INVALID_PARTY_LEVEL");
    }
    // Shared for the workspace only: the party sees nothing.
    const shared = await share(w.a, space, agent);
    expect((await g("GET", `/guest/spaces/${space}`)).body.resources).toEqual([]);
    await w.a("PATCH", `/spaces/${space}/resources/${shared.body.resource.id}`, {
      per_party: { [party]: "run" },
    });
    const seen = await g("GET", `/guest/spaces/${space}`);
    expect(seen.body.resources).toMatchObject([
      { resource_type: "agent", name: "Diligence", access: "run" },
    ]);
    expect(JSON.stringify(seen.body)).not.toContain("walk-away");
    const rows = await asApp(pool, me, async (db) => {
      const count = async (sql: string) => (await db.query(sql)).rows.length;
      return {
        agent: await count("select 1 from work.agent"),
        version: await count("select 1 from work.agent_version"),
        document: await count("select 1 from work.agent_document"),
        forRun: (await db.query("select work.agent_level($1) as l", [agent])).rows[0].l,
        task: await count("select 1 from work.task"),
        comment: await count("select 1 from work.task_comment"),
        run: await count("select 1 from work.run"),
        step: await count("select 1 from work.run_step"),
        event: await count("select 1 from work.run_event"),
        thread: await count("select 1 from work.thread"),
      };
    });
    expect(rows).toEqual({
      agent: 0,
      version: 0,
      document: 0,
      forRun: null,
      task: 0,
      comment: 0,
      run: 0,
      step: 0,
      event: 0,
      thread: 0,
    });
    expect((await g("GET", `/spaces/${space}/requests`)).status).not.toBe(200);
  });
});

describe("walls on an agent's files", () => {
  it("blocks the share, and closes a grant while anyone in the Space is walled", async () => {
    const w = await world();
    const matterId = await one(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name,
                                require_walls_for_sharing)
       values ($1, '1', 'Acme', 'W-1', 'W-1', true) returning id`,
      [w.ana.workspaceId],
    );
    const vaultId = await one(
      `insert into content.vault (workspace_id, owner_id, name, matter_id)
       values ($1, $2, 'Data room', $3) returning id`,
      [w.ana.workspaceId, w.ana.userId, matterId],
    );
    const agent = await w.agent(w.ana, vaultId);
    const wall = () =>
      one(
        `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
         values ($1, $2, 'user', $3, 'deny') returning id`,
        [w.ana.workspaceId, matterId, w.cal.userId],
      );
    const space = await room(w, "internal");

    const row = await wall();
    const blocked = await share(w.a, space, agent);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("WALL_SHARE_BLOCKED");

    await pool.query("delete from core.wall where id = $1", [row]);
    expect((await share(w.a, space, agent)).status).toBe(201);
    expect((await w.agents.get(w.principal(w.cal), agent))?.agent.my_access).toBe("run");

    // A wall raised afterwards closes the grant, and lifting it opens it again.
    const later = await wall();
    expect(await w.agents.get(w.principal(w.cal), agent)).toBeNull();
    const task = await w.c("POST", `/spaces/${space}/tasks`, {
      name: "Check it",
      assignee: { type: "agent", agent_id: agent },
    });
    expect(task.body.code).toBe("AGENT_NOT_SHARED");
    await pool.query("delete from core.wall where id = $1", [later]);
    expect((await w.agents.get(w.principal(w.cal), agent))?.agent.my_access).toBe("run");

    // A guest has no allow row on the matter, so an external Space with one refuses it.
    const outside = await room(w, "external");
    await guestIn(w, outside);
    expect((await share(w.a, outside, agent)).body.code).toBe("WALL_SHARE_BLOCKED");
  });

  it("keeps another matter's files out of a matter's Space", async () => {
    const w = await world();
    const matterOf = (n: string) =>
      one(
        `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name)
         values ($1, '1', 'Acme', $2, $2) returning id`,
        [w.ana.workspaceId, n],
      );
    const vaultId = await one(
      `insert into content.vault (workspace_id, owner_id, name, matter_id)
       values ($1, $2, 'Other room', $3) returning id`,
      [w.ana.workspaceId, w.ana.userId, await matterOf("M-2")],
    );
    const agent = await w.agent(w.ana, vaultId);
    const space = await room(w, "internal", await matterOf("M-1"));
    expect((await share(w.a, space, agent)).body.code).toBe("MATTER_MISMATCH");
  });
});
