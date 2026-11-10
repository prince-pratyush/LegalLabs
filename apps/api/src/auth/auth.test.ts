import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, PASSWORD, seedMember, testPool } from "../test-db.js";
import { createAuth } from "./auth.js";

const pool = testPool();
const auth = createAuth(pool);
const client = { ip: "203.0.113.9", userAgent: "vitest" };

afterAll(() => pool.end());

describe("a session", () => {
  const signIn = async () => {
    const m = await seedMember(pool);
    const result = await auth.login(
      { workspace: m.slug, email: m.email, password: PASSWORD },
      client,
    );
    if (!result) throw new Error("sign-in failed");
    return { m, ...result };
  };

  it("resolves to the person it belongs to", async () => {
    const { token, principal } = await signIn();
    expect(await auth.resolve(token)).toEqual(principal);
  });

  it("does not resolve from a made-up token", async () => {
    expect(await auth.resolve("made-up")).toBeNull();
  });

  it("stops working the moment the person is suspended", async () => {
    const { m, token } = await signIn();
    await pool.query(`update core."user" set status = 'suspended' where id = $1`, [m.userId]);
    expect(await auth.resolve(token)).toBeNull();
  });

  it("stops working once expired", async () => {
    const { m, token } = await signIn();
    await pool.query("update core.session set expires_at = now() where user_id = $1", [m.userId]);
    expect(await auth.resolve(token)).toBeNull();
  });

  it("ends on sign-out, once, and records it", async () => {
    const { m, token, principal } = await signIn();
    await auth.logout(token, client);
    await auth.logout(token, client);
    expect(await auth.resolve(token)).toBeNull();
    expect((await auditTrail(pool, m.workspaceId)).slice(1)).toMatchObject([
      {
        action: "logout",
        actor_type: "user",
        actor_id: m.userId,
        object_type: "session",
        object_id: principal.sessionId,
      },
    ]);
  });

  it("ignores sign-out with a made-up token", async () => {
    await expect(auth.logout("made-up", client)).resolves.toBeUndefined();
  });
});

describe("a failed sign-in", () => {
  const attempt = async (workspace: string, email: string, password: string) =>
    auth.login({ workspace, email, password }, client);

  it("is refused, recorded as a system event, and keeps nothing that was typed", async () => {
    const m = await seedMember(pool);
    expect(await attempt(m.slug, m.email, "wrong password here")).toBeNull();
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail).toEqual([
      {
        action: "login.failure",
        actor_type: "system",
        actor_id: null,
        object_type: "user",
        object_id: m.userId,
        details: { reason: "bad_password" },
      },
    ]);
    expect(JSON.stringify(trail)).not.toContain("wrong password here");
    const { rows } = await pool.query("select 1 from core.session where user_id = $1", [m.userId]);
    expect(rows).toEqual([]);
  });

  it("names no one when the email is unknown, and keeps the typed email out", async () => {
    const m = await seedMember(pool);
    expect(await attempt(m.slug, "nobody@example.test", PASSWORD)).toBeNull();
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail).toMatchObject([{ action: "login.failure", object_type: null, object_id: null }]);
    expect(trail[0].details).toEqual({ reason: "unknown_user" });
    expect(JSON.stringify(trail)).not.toContain("nobody@example.test");
  });

  it("refuses a suspended person even with the right password", async () => {
    const m = await seedMember(pool, { status: "suspended" });
    expect(await attempt(m.slug, m.email, PASSWORD)).toBeNull();
    expect((await auditTrail(pool, m.workspaceId))[0].details).toEqual({ reason: "not_active" });
  });

  it("refuses someone who has no password set", async () => {
    const m = await seedMember(pool, { password: false });
    expect(await attempt(m.slug, m.email, PASSWORD)).toBeNull();
    expect((await auditTrail(pool, m.workspaceId))[0].details).toEqual({ reason: "no_password" });
  });

  it("is refused quietly for an unknown workspace, which has no log to write to", async () => {
    expect(await attempt("no-such-workspace", "a@example.test", PASSWORD)).toBeNull();
  });
});

describe("signing in", () => {
  it("issues a 256-bit token and keeps only its hash", async () => {
    const m = await seedMember(pool);
    const result = await auth.login(
      { workspace: m.slug, email: m.email, password: PASSWORD },
      client,
    );
    expect(result?.principal).toMatchObject({ userId: m.userId, workspaceId: m.workspaceId });
    expect(Buffer.from(result?.token ?? "", "base64url")).toHaveLength(32);

    const { rows } = await pool.query(
      "select token_hash, expires_at - created_at as life, ip from core.session where user_id = $1",
      [m.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toEqual(
      createHash("sha256")
        .update(result?.token ?? "")
        .digest(),
    );
    expect(rows[0].life.hours).toBe(12);
    expect(rows[0].ip).toBe("203.0.113.9");
  });

  it("records who signed in", async () => {
    const m = await seedMember(pool);
    const result = await auth.login(
      { workspace: m.slug, email: m.email, password: PASSWORD },
      client,
    );
    expect(await auditTrail(pool, m.workspaceId)).toEqual([
      {
        action: "login.success",
        actor_type: "user",
        actor_id: m.userId,
        object_type: "session",
        object_id: result?.principal.sessionId,
        details: {},
      },
    ]);
  });
});
