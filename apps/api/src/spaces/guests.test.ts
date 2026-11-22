import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createVaults } from "../vaults/vaults.js";
import { recordingGuestMailer } from "./guests.js";
import { createSpaceModule } from "./module.js";
import { scriptedTaskRuns } from "./ports.js";

const pool = testPool();
afterAll(() => pool.end());

const one = async (sql: string, params: unknown[]) =>
  (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";

type Reply = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field
  body: any;
  cookie: string;
};

async function world() {
  const ana = await seedMember(pool);
  const mailer = recordingGuestMailer();
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
    spaces: createSpaceModule(pool, { runs: scriptedTaskRuns(), guest: { mailer } }),
    clientIp: () => "203.0.113.9",
  });
  const send = async (
    prefix: string,
    cookie: string,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<Reply> => {
    const res = await app.request(`${prefix}${path}`, {
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
  const login = await send("", "", "POST", "/auth/login", {
    workspace: ana.slug,
    email: ana.email,
    password: PASSWORD,
  });
  const annaCookie = login.cookie;
  return {
    ana,
    mailer,
    /** Ana, in the workspace. */
    a: (method: string, path: string, json?: unknown) =>
      send("/api/v1", annaCookie, method, path, json),
    /** Anyone, signed out: the public guest endpoints. */
    pub: (method: string, path: string, json?: unknown) => send("/guest", "", method, path, json),
    /** A guest with a session cookie. */
    asGuest: (cookie: string) => (method: string, path: string, json?: unknown) =>
      send("/api/v1", cookie, method, path, json),
    request: app.request.bind(app),
  };
}
type World = Awaited<ReturnType<typeof world>>;

const OTHER = "lead@other.test";

/** An external Space of Ana's with one party, Other LLP, whose lead is the guest-side approver. */
async function external(w: World) {
  const made = await w.a("POST", "/spaces", { name: "Outside deal", kind: "external" });
  expect(made.status).toBe(201);
  const space: string = made.body.space.id;
  const added = await w.a("POST", `/spaces/${space}/parties`, {
    name: "Other LLP",
    domain: "other.test",
    connection_admin_emails: [OTHER],
  });
  expect(added.status).toBe(201);
  return { space, party: added.body.party.id as string };
}

/** Invites, accepts and signs in a guest, the way the pages do. */
async function guestIn(w: World, space: string, email = OTHER) {
  const invited = await w.a("POST", `/spaces/${space}/guests`, { email });
  expect(invited.status).toBe(201);
  const token: string = invited.body.token;
  const accepted = await w.pub("POST", "/invites/accept", { token, name: "Lee" });
  expect(accepted.status).toBe(200);
  const slug: string = accepted.body.workspace;
  const before = w.mailer.sent.length;
  expect((await w.pub("POST", "/login/code", { workspace: slug, email })).status).toBe(204);
  const sent = w.mailer.sent[before];
  expect(sent).toBeDefined();
  const verified = await w.pub("POST", "/login/verify", {
    workspace: slug,
    email,
    code: sent?.code,
  });
  expect(verified.status).toBe(200);
  return { cookie: verified.cookie, token, slug, g: w.asGuest(verified.cookie) };
}

const makeVault = (w: World) =>
  one(
    `insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Data room') returning id`,
    [w.ana.workspaceId, w.ana.userId],
  );

describe("external Spaces and guests", () => {
  it("runs the whole flow over HTTP", async () => {
    const w = await world();
    const { space, party } = await external(w);

    // Parties: the live one, connection pending, shown on the Space.
    const listed = await w.a("GET", `/spaces/${space}/parties`);
    expect(listed.body.parties).toHaveLength(1);
    expect(listed.body.parties[0].connection.status).toBe("action_required");
    expect((await w.a("GET", `/spaces/${space}`)).body.space.external_parties).toEqual([
      "Other LLP",
    ]);

    // An invite is checked against the party's domain; nothing is stored for a refusal.
    const wrong = await w.a("POST", `/spaces/${space}/guests`, { email: "x@elsewhere.test" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("GUEST_DOMAIN_MISMATCH");
    expect(
      (await w.a("POST", `/spaces/${space}/parties`, { name: "Two", domain: "t.test" })).body.code,
    ).toBe("PARTY_LIMIT");

    // The invitation: a link whose token the server keeps only a hash of.
    const invited = await w.a("POST", `/spaces/${space}/guests`, { email: OTHER, access_days: 30 });
    expect(invited.status).toBe(201);
    expect(invited.body.accept_url).toContain(invited.body.token);
    const token: string = invited.body.token;
    expect(
      (
        await pool.query(
          "select 1 from work.guest_invite where token_hash = sha256($1::text::bytea)",
          [token],
        )
      ).rowCount,
    ).toBe(1);

    const preview = await w.pub("POST", "/invites/preview", { token });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      email: OTHER,
      space_name: "Outside deal",
      party_name: "Other LLP",
    });
    expect((await w.pub("POST", "/invites/preview", { token: "x".repeat(43) })).status).toBe(404);

    const accepted = await w.pub("POST", "/invites/accept", { token, name: "Lee" });
    expect(accepted.status).toBe(200);
    // Spent: a second accept finds nothing.
    expect((await w.pub("POST", "/invites/accept", { token, name: "Lee" })).body.code).toBe(
      "INVITE_INVALID",
    );

    // Sign in with an emailed code.
    const slug: string = accepted.body.workspace;
    expect((await w.pub("POST", "/login/code", { workspace: slug, email: OTHER })).status).toBe(
      204,
    );
    expect(w.mailer.sent).toHaveLength(1);
    const code = w.mailer.sent[0]?.code ?? "";
    expect(code).toMatch(/^\d{8}$/);
    const verified = await w.pub("POST", "/login/verify", { workspace: slug, email: OTHER, code });
    expect(verified.status).toBe(200);
    expect(verified.cookie).toContain("sid=");
    const g = w.asGuest(verified.cookie);
    // The session is hard 24 hours, not the 12 hour member session.
    const hours = await pool.query<{ h: number }>(
      `select extract(epoch from (expires_at - created_at)) / 3600 as h
         from core.session where user_id = (select id from core."user" where email = $1 and workspace_id = $2)`,
      [OTHER, w.ana.workspaceId],
    );
    expect(Math.round(hours.rows[0]?.h ?? 0)).toBe(24);
    // A spent code is spent.
    expect(
      (await w.pub("POST", "/login/verify", { workspace: slug, email: OTHER, code })).status,
    ).toBe(401);

    // Before approval the guest knows the Space exists (to approve), and sees nothing in it.
    const mine = await g("GET", "/guest/spaces");
    expect(mine.body.spaces).toHaveLength(1);
    expect(mine.body.spaces[0]).toMatchObject({
      connection_status: "action_required",
      can_approve: true,
    });
    expect((await g("GET", `/guest/spaces/${space}`)).status).toBe(404);

    // Both sides approve, in either order. Resources can't go outward before that.
    const vault = await makeVault(w);
    const early = await w.a("POST", `/spaces/${space}/resources`, {
      resource_type: "vault",
      resource_id: vault,
      access: "view",
      per_party: { [party]: "view" },
    });
    expect(early.body.code).toBe("CONNECTION_NOT_APPROVED");
    expect((await w.a("POST", `/spaces/${space}/parties/${party}/approve`)).body.status).toBe(
      "in_progress",
    );
    expect((await w.a("POST", `/spaces/${space}/parties/${party}/approve`)).body.code).toBe(
      "ALREADY_APPROVED",
    );
    expect((await g("GET", `/guest/spaces/${space}`)).status).toBe(404);
    expect((await g("POST", `/guest/spaces/${space}/connection/approve`)).body.status).toBe(
      "resolved",
    );

    // Sharing: the guest's party gets View, everyone else nothing.
    const shared = await w.a("POST", `/spaces/${space}/resources`, {
      resource_type: "vault",
      resource_id: vault,
      access: "view",
      per_party: { [party]: "view" },
    });
    expect(shared.status).toBe(201);
    expect(shared.body.resource.per_party).toEqual({ [party]: "view" });
    expect(shared.body.resource.external_parties).toEqual(["Other LLP"]);
    const seen = await g("GET", `/guest/spaces/${space}`);
    expect(seen.status).toBe(200);
    expect(seen.body.space).toMatchObject({ name: "Outside deal", kind: "external" });
    expect(seen.body.party.name).toBe("Other LLP");
    expect(seen.body.resources).toHaveLength(1);
    expect(seen.body.resources[0]).toMatchObject({
      resource_type: "vault",
      resource_id: vault,
      name: "Data room",
      access: "view",
    });
    expect(JSON.stringify(seen.body)).not.toContain(w.ana.userId);

    // Admins see the guest.
    const guests = await w.a("GET", `/spaces/${space}/guests`);
    expect(guests.body.guests).toHaveLength(1);
    expect(guests.body.guests[0]).toMatchObject({ email: OTHER, status: "active", name: "Lee" });

    // Withdrawing the party's access takes the resource away at once.
    expect(
      (
        await w.a("PATCH", `/spaces/${space}/resources/${shared.body.resource.id}`, {
          per_party: { [party]: "none" },
        })
      ).status,
    ).toBe(200);
    expect((await g("GET", `/guest/spaces/${space}`)).body.resources).toHaveLength(0);
    await w.a("PATCH", `/spaces/${space}/resources/${shared.body.resource.id}`, {
      per_party: { [party]: "edit" },
    });
    expect((await g("GET", `/guest/spaces/${space}`)).body.resources[0].access).toBe("edit");

    // Everything is audited.
    const actions = (await auditTrail(pool, w.ana.workspaceId)).map((e) => e.action as string);
    for (const action of [
      "space.created",
      "space.party_added",
      "space.guest_invited",
      "space.guest_joined",
      "guest.login_code_issued",
      "guest.login_succeeded",
      "space.connection_approved",
      "space.party_level_changed",
      "space.external_access",
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(actions.filter((a) => a === "space.connection_approved")).toHaveLength(2);
    // No code or token in the log.
    const trail = JSON.stringify(await auditTrail(pool, w.ana.workspaceId));
    expect(trail).not.toContain(token);
    expect(trail).not.toContain(code);

    // Removing the guest ends their session as well.
    const gone = (guests.body.guests[0] as { user_id: string }).user_id;
    expect((await w.a("DELETE", `/spaces/${space}/guests/${gone}`)).status).toBe(204);
    expect((await g("GET", "/guest/spaces")).status).toBe(401);
    expect((await auditTrail(pool, w.ana.workspaceId)).map((e) => e.action)).toContain(
      "space.guest_removed",
    );
  });

  it("keeps a guest out of everything but the guest endpoints", async () => {
    const w = await world();
    const { space, party } = await external(w);
    const { g, cookie } = await guestIn(w, space);
    await w.a("POST", `/spaces/${space}/parties/${party}/approve`);
    await g("POST", `/guest/spaces/${space}/connection/approve`);

    for (const [method, path, body] of [
      ["GET", "/vaults"],
      ["GET", "/spaces"],
      ["GET", `/spaces/${space}`],
      ["POST", "/threads", { title: "hi" }],
      ["POST", "/spaces", { name: "Mine" }],
      ["GET", `/spaces/${space}/parties`],
      ["POST", `/spaces/${space}/guests`, { email: "a@other.test" }],
      ["POST", `/spaces/${space}/parties/${party}/approve`],
      ["GET", "/documents/00000000-0000-7000-8000-000000000000"],
      ["GET", "/nothing-at-all"],
    ] as [string, string, unknown?][]) {
      const res = await g(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // A member is not a guest either.
    expect((await w.a("GET", "/guest/spaces")).status).toBe(403);
    // Signing out still works for a guest.
    const out = await w.request("/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(out.status).toBe(204);
    expect((await g("GET", "/guest/spaces")).status).toBe(401);
  });

  it("locks a guest out after five wrong codes", async () => {
    const w = await world();
    const { space } = await external(w);
    const invited = await w.a("POST", `/spaces/${space}/guests`, { email: OTHER });
    const accepted = await w.pub("POST", "/invites/accept", {
      token: invited.body.token,
      name: "Lee",
    });
    const slug: string = accepted.body.workspace;
    await w.pub("POST", "/login/code", { workspace: slug, email: OTHER });
    const real = w.mailer.sent[0]?.code ?? "";
    const wrong = real === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 5; i++) {
      const res = await w.pub("POST", "/login/verify", {
        workspace: slug,
        email: OTHER,
        code: wrong,
      });
      expect(res.status).toBe(401);
    }
    // Even the right code now fails: locked for 15 minutes.
    const late = await w.pub("POST", "/login/verify", {
      workspace: slug,
      email: OTHER,
      code: real,
    });
    expect(late.status).toBe(401);
    const profile = await pool.query<{ locked: boolean }>(
      "select locked_until > now() as locked from core.guest_profile where workspace_id = $1",
      [w.ana.workspaceId],
    );
    expect(profile.rows[0]?.locked).toBe(true);
    const trail = await auditTrail(pool, w.ana.workspaceId);
    expect(trail.filter((e) => e.action === "guest.login_failed").length).toBeGreaterThanOrEqual(5);
  });

  it("answers a code request the same for a stranger", async () => {
    const w = await world();
    const { space } = await external(w);
    await guestIn(w, space);
    const before = w.mailer.sent.length;
    const res = await w.pub("POST", "/login/code", {
      workspace: w.ana.slug,
      email: "nobody@other.test",
    });
    expect(res.status).toBe(204);
    const nowhere = await w.pub("POST", "/login/code", {
      workspace: "no-such-workspace",
      email: OTHER,
    });
    expect(nowhere.status).toBe(204);
    expect(w.mailer.sent.length).toBe(before);
    // A member's address never gets a guest code.
    expect(
      (await w.pub("POST", "/login/code", { workspace: w.ana.slug, email: w.ana.email })).status,
    ).toBe(204);
    expect(w.mailer.sent.length).toBe(before);
    expect(
      (
        await w.pub("POST", "/login/verify", {
          workspace: w.ana.slug,
          email: OTHER,
          code: "12345678",
        })
      ).status,
    ).toBe(401);
    expect((await w.pub("POST", "/login/code", { workspace: "x", email: "bad" })).status).toBe(400);
  });

  it("refuses an expired guest's existing session", async () => {
    const w = await world();
    const { space } = await external(w);
    const { g } = await guestIn(w, space);
    expect((await g("GET", "/guest/spaces")).status).toBe(200);
    await pool.query(
      "update core.guest_profile set expires_at = now() - interval '1 minute' where workspace_id = $1",
      [w.ana.workspaceId],
    );
    expect((await g("GET", "/guest/spaces")).status).toBe(401);
  });

  it("takes everything back when the connection is rejected", async () => {
    const w = await world();
    const { space, party } = await external(w);
    const { g } = await guestIn(w, space);
    await w.a("POST", `/spaces/${space}/parties/${party}/approve`);
    expect((await g("POST", `/guest/spaces/${space}/connection/approve`)).status).toBe(200);
    expect((await g("GET", `/guest/spaces/${space}`)).status).toBe(200);
    const rejected = await w.a("POST", `/spaces/${space}/parties/${party}/reject`, {
      reason: "Wrong firm",
    });
    expect(rejected.status).toBe(204);
    // Their only Space is gone, so their session is too.
    expect((await g("GET", `/guest/spaces/${space}`)).status).toBe(401);
    expect((await w.a("GET", `/spaces/${space}/parties`)).body.parties).toHaveLength(0);
    expect((await w.a("GET", `/spaces/${space}`)).body.space.external_parties).toEqual([]);
    const trail = (await auditTrail(pool, w.ana.workspaceId)).map((e) => e.action);
    expect(trail).toContain("space.connection_rejected");
  });

  it("lets the guest side reject too, and removes the party", async () => {
    const w = await world();
    const { space, party } = await external(w);
    const { g } = await guestIn(w, space);
    expect(
      (await g("POST", `/guest/spaces/${space}/connection/reject`, { reason: "No" })).status,
    ).toBe(204);
    expect((await w.a("GET", `/spaces/${space}/parties`)).body.parties).toHaveLength(0);
    // A new party can then be added, and the old one is gone.
    expect((await w.a("DELETE", `/spaces/${space}/parties/${party}`)).status).toBe(404);
    expect(
      (await w.a("POST", `/spaces/${space}/parties`, { name: "Third", domain: "third.test" }))
        .status,
    ).toBe(201);
  });

  it("removes a party and its guests", async () => {
    const w = await world();
    const { space, party } = await external(w);
    const { g } = await guestIn(w, space);
    expect((await w.a("DELETE", `/spaces/${space}/parties/${party}`)).status).toBe(204);
    expect((await g("GET", "/guest/spaces")).status).toBe(401);
    expect((await auditTrail(pool, w.ana.workspaceId)).map((e) => e.action)).toContain(
      "space.party_removed",
    );
  });

  it("needs spaces.external, an external Space and a real party", async () => {
    const w = await world();
    const role = await one(
      "insert into core.role (workspace_id, name, permissions) values ($1, 'Plain', $2) returning id",
      [w.ana.workspaceId, ["threads.use", "spaces.create"]],
    );
    const email = `dan-${randomUUID().slice(0, 6)}@${w.ana.slug}.test`;
    const dan = await one(
      `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
      [w.ana.workspaceId, email, role],
    );
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [w.ana.workspaceId, dan, await hashPassword(PASSWORD)],
    );
    const login = await w.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: w.ana.slug, email, password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const d = w.asGuest(cookie);
    const refused = await d("POST", "/spaces", { name: "Out", kind: "external" });
    expect(refused.status).toBe(403);

    // An internal Space takes no party, and per-party levels need an external one.
    const internal = await w.a("POST", "/spaces", { name: "In" });
    const id: string = internal.body.space.id;
    expect(
      (await w.a("POST", `/spaces/${id}/parties`, { name: "X", domain: "x.test" })).body.code,
    ).toBe("SPACE_NOT_EXTERNAL");
    const vault = await makeVault(w);
    const bad = await w.a("POST", `/spaces/${id}/resources`, {
      resource_type: "vault",
      resource_id: vault,
      access: "view",
      per_party: { [randomUUID()]: "view" },
    });
    expect(bad.status).toBe(400);
    expect((await w.a("POST", `/spaces/${id}/guests`, { email: "a@x.test" })).body.code).toBe(
      "NO_PARTY",
    );
    expect((await w.a("POST", `/spaces/${id}/parties`, { name: "", domain: "nope" })).status).toBe(
      400,
    );
  });
});
