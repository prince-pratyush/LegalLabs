import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";

// Two workspaces with a row in every table, inserted as the schema owner.
export async function seed(tx: Tx) {
  await tx.asOwner();
  const tag = randomUUID().slice(0, 8);
  const id = async (sql: string, params: unknown[]) =>
    (await tx.one<{ id: string }>(sql, params)).id;

  const workspace = (slug: string) =>
    id("insert into core.workspace (slug, name, region) values ($1, $1, 'au') returning id", [
      `${slug}-${tag}`,
    ]);
  const role = (ws: string, name: string, permissions: string[]) =>
    id("insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id", [
      ws,
      name,
      permissions,
    ]);
  const user = (
    ws: string,
    email: string,
    roleId: string,
    opts: { status?: string; kind?: string; extra?: string[] } = {},
  ) =>
    id(
      `insert into core."user" (workspace_id, email, role_id, status, kind, extra_permissions)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ws, email, roleId, opts.status ?? "active", opts.kind ?? "member", opts.extra ?? []],
    );

  const acme = await workspace("acme");
  const beta = await workspace("beta");
  const acmeAdmin = await role(acme, "Admin", ["*"]);
  const acmeUser = await role(acme, "User", ["threads.use"]);
  const betaAdmin = await role(beta, "Admin", ["*"]);

  const ana = await user(acme, "ana@acme.test", acmeAdmin);
  const ben = await user(acme, "ben@acme.test", acmeUser);
  const cal = await user(acme, "cal@acme.test", acmeUser);
  const sue = await user(acme, "sue@acme.test", acmeAdmin, { status: "suspended" });
  const gia = await user(acme, "gia@guest.test", acmeUser, {
    kind: "guest",
    extra: ["admin.users"],
  });
  const bob = await user(beta, "bob@beta.test", betaAdmin);

  return { acme, beta, roles: { acmeAdmin, acmeUser, betaAdmin }, ana, ben, cal, sue, gia, bob };
}

export type Seed = Awaited<ReturnType<typeof seed>>;
