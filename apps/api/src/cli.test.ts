import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createAuth } from "./auth/auth.js";
import { run } from "./cli.js";
import { testPool } from "./test-db.js";

const pool = testPool();
const auth = createAuth(pool);
const client = { ip: null, userAgent: null };
afterAll(() => pool.end());

function io(password: string) {
  const lines: string[] = [];
  return {
    lines,
    io: {
      databaseUrl: inject("databaseUrl") as string | undefined,
      readPassword: async () => password,
      print: (line: string) => lines.push(line),
    },
  };
}

const fresh = () => {
  const slug = `cli-${randomUUID().slice(0, 8)}`;
  return { slug, email: `owner@${slug}.test` };
};
const GOOD = "a long enough password";

describe("legallabs-admin create-admin", () => {
  it("makes a first admin who can sign in", async () => {
    const { slug, email } = fresh();
    expect(await run(["create-admin", slug, email], io(GOOD).io)).toBe(0);
    const result = await auth.login({ workspace: slug, email, password: GOOD }, client);
    expect(result).not.toBeNull();
    const { rows } = await pool.query(
      `select a.action, a.actor_type from admin.audit_event a where a.workspace_id = $1 order by seq`,
      [result?.principal.workspaceId],
    );
    expect(rows[0]).toEqual({ action: "user.password_set", actor_type: "system" });
  });

  it("replaces the password when run again", async () => {
    const { slug, email } = fresh();
    await run(["create-admin", slug, email], io(GOOD).io);
    expect(await run(["create-admin", slug, email], io("another long password").io)).toBe(0);
    expect(await auth.login({ workspace: slug, email, password: GOOD }, client)).toBeNull();
    expect(
      await auth.login({ workspace: slug, email, password: "another long password" }, client),
    ).not.toBeNull();
  });

  it("on an existing person changes only the password, and ends their sessions", async () => {
    const { slug, email } = fresh();
    await run(["create-admin", slug, email], io(GOOD).io);
    const signedIn = await auth.login({ workspace: slug, email, password: GOOD }, client);
    await pool.query(`update core."user" set status = 'suspended' where lower(email) = $1`, [
      email,
    ]);
    expect(await run(["create-admin", slug, email], io("another long password").io)).toBe(0);
    const { rows } = await pool.query(`select status from core."user" where lower(email) = $1`, [
      email,
    ]);
    expect(rows).toEqual([{ status: "suspended" }]);
    await pool.query(`update core."user" set status = 'active' where lower(email) = $1`, [email]);
    expect(await auth.resolve(signedIn?.token ?? "")).toBeNull();
  });

  it("refuses a short password and creates nothing", async () => {
    const { slug, email } = fresh();
    const h = io("too short");
    expect(await run(["create-admin", slug, email], h.io)).toBe(1);
    expect(h.lines.join()).toContain("at least 12");
    const { rows } = await pool.query("select 1 from core.workspace where slug = $1", [slug]);
    expect(rows).toEqual([]);
  });

  it("prints usage for anything else", async () => {
    expect(await run(["nonsense"], io(GOOD).io)).toBe(2);
  });

  it("explains a missing database setting", async () => {
    const { slug, email } = fresh();
    const h = io(GOOD);
    expect(await run(["create-admin", slug, email], { ...h.io, databaseUrl: undefined })).toBe(2);
    expect(h.lines.join()).toContain("DATABASE_URL");
  });
});

describe("legallabs-admin create-user", () => {
  const roleAndPermissions = async (email: string) =>
    (
      await pool.query(
        `select r.name, r.permissions, u.status from core."user" u
           join core.role r on r.id = u.role_id where u.email = $1`,
        [email],
      )
    ).rows[0];

  it("makes an ordinary user, not an administrator", async () => {
    const { slug, email } = fresh();
    await run(["create-admin", slug, email], io(GOOD).io);
    const other = `second@${slug}.test`;
    expect(await run(["create-user", slug, other], io(GOOD).io)).toBe(0);
    const row = await roleAndPermissions(other);
    expect(row).toMatchObject({ name: "User", status: "active" });
    expect(row.permissions).toContain("threads.use");
    expect(row.permissions.join()).not.toMatch(/\*|admin\./);
    expect(
      await auth.login({ workspace: slug, email: other, password: GOOD }, client),
    ).not.toBeNull();
  });

  it("will not give administrator rights, even when asked by name", async () => {
    const { slug, email } = fresh();
    await run(["create-admin", slug, email], io(GOOD).io);
    const h = io(GOOD);
    expect(await run(["create-user", slug, `b@${slug}.test`, "Admin"], h.io)).toBe(1);
    expect(h.lines.join()).toContain("create-admin");
    expect(await roleAndPermissions(`b@${slug}.test`)).toBeUndefined();
  });

  it("leaves someone who exists, an unknown workspace and an unknown role alone", async () => {
    const { slug, email } = fresh();
    await run(["create-admin", slug, email], io(GOOD).io);
    expect(await run(["create-user", slug, email], io("another long password").io)).toBe(1);
    expect(await auth.login({ workspace: slug, email, password: GOOD }, client)).not.toBeNull();
    expect(await run(["create-user", "nowhere-at-all", `c@${slug}.test`], io(GOOD).io)).toBe(1);
    expect(await run(["create-user", slug, `c@${slug}.test`, "Nope"], io(GOOD).io)).toBe(1);
    expect(await run(["create-user", slug, `c@${slug}.test`], io("short").io)).toBe(1);
    const { rows } = await pool.query(`select 1 from core."user" where email = $1`, [
      `c@${slug}.test`,
    ]);
    expect(rows).toEqual([]);
  });
});
