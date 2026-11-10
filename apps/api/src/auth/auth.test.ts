import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, PASSWORD, seedMember, testPool } from "../test-db.js";
import { createAuth } from "./auth.js";

const pool = testPool();
const auth = createAuth(pool);
const client = { ip: "203.0.113.9", userAgent: "vitest" };

afterAll(() => pool.end());

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
