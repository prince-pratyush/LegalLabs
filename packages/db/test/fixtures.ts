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
  const gia = await id(
    `insert into core."user" (workspace_id, email, status, kind) values ($1, 'gia@guest.test', 'active', 'guest') returning id`,
    [acme],
  );
  // Holds admin.users but not admin.matters, to test that it cannot grant more.
  const dee = await user(acme, "dee@acme.test", acmeUser, { extra: ["admin.users"] });
  const bob = await user(beta, "bob@beta.test", betaAdmin);

  const group = (ws: string, name: string, visibility: string, kind = "standard") =>
    id(
      `insert into core."group" (workspace_id, name, visibility, kind) values ($1, $2, $3, $4) returning id`,
      [ws, name, visibility, kind],
    );
  const join = (ws: string, groupId: string, userIds: string[]) =>
    Promise.all(
      userIds.map((u) =>
        tx.rows(
          "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
          [ws, groupId, u],
        ),
      ),
    );

  const corpTeam = await group(acme, "corp-team", "private");
  const litTeam = await group(acme, "lit-team", "private");
  const everyone = await group(acme, "everyone", "public");
  const partyP = await group(acme, "party-p", "private", "party");
  const betaTeam = await group(beta, "beta-team", "private");
  await join(acme, corpTeam, [ana, ben]);
  await join(acme, litTeam, [cal]);
  await join(acme, partyP, [gia]);
  await join(beta, betaTeam, [bob]);

  const matter = (ws: string, number: string, mode: string) =>
    id(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', $2, $2, $3) returning id`,
      [ws, number, mode],
    );
  const wall = (ws: string, matterId: string, type: string, principal: string, effect: string) =>
    tx.rows(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, $3, $4, $5)`,
      [ws, matterId, type, principal, effect],
    );

  // The worked example from the walls spec, plus M3: an allow-list nobody is on yet.
  const m1 = await matter(acme, "M1", "allow_list");
  const m2 = await matter(acme, "M2", "open");
  const m3 = await matter(acme, "M3", "allow_list");
  const mb = await matter(beta, "MB", "open");
  await wall(acme, m1, "group", corpTeam, "allow");
  await wall(acme, m1, "user", ben, "deny");
  await wall(acme, m2, "user", cal, "deny");
  await wall(beta, mb, "group", betaTeam, "allow");
  await tx.rows(
    `insert into core.matter_acknowledgement (workspace_id, user_id, matter_id, notice_version)
     values ($1, $2, $3, 1), ($4, $5, $6, 1)`,
    [acme, ana, m2, beta, bob, mb],
  );

  // Objects arrive in later modules; a share only needs a type and an id.
  const t1 = await id("select core.uuid7() as id", []);
  const tb = await id("select core.uuid7() as id", []);
  const share = (
    ws: string,
    objectId: string,
    type: string,
    principal: string,
    level: string,
    by: string,
  ) =>
    tx.rows(
      `insert into core.share_grant
         (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
       values ($1, 'thread', $2, $3, $4, $5, $6)`,
      [ws, objectId, type, principal, level, by],
    );
  await share(acme, t1, "group", corpTeam, "view", ana);
  await share(acme, t1, "user", cal, "edit", ana);
  await share(beta, tb, "workspace", beta, "view", bob);

  // Only hashes are stored; tests hold the raw secrets to look them up again.
  const session = (ws: string, userId: string, secret: string, expires = "1 day") =>
    tx.rows(
      `insert into core.session (workspace_id, user_id, token_hash, expires_at)
       values ($1, $2, sha256(convert_to($3, 'utf8')), now() + $4::interval)`,
      [ws, userId, secret, expires],
    );
  const token = (ws: string, userId: string, secret: string, scopes: string[]) =>
    tx.rows(
      `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
       values ($1, $2, 'test', sha256(convert_to($3, 'utf8')), $4, now() + interval '90 days')`,
      [ws, userId, secret, scopes],
    );
  const secrets = {
    ana: `sid-ana-${tag}`,
    ben: `sid-ben-${tag}`,
    sue: `sid-sue-${tag}`,
    expired: `sid-old-${tag}`,
    bob: `sid-bob-${tag}`,
    anaToken: `cns_ana_${tag}`,
    bobToken: `cns_bob_${tag}`,
  };
  await session(acme, ana, secrets.ana);
  await session(acme, ben, secrets.ben);
  await session(acme, sue, secrets.sue);
  await session(acme, ana, secrets.expired, "-1 hour");
  await session(beta, bob, secrets.bob);
  await token(acme, ana, secrets.anaToken, ["audit:read"]);
  await token(beta, bob, secrets.bobToken, ["whoami"]);

  return {
    slugs: { acme: `acme-${tag}`, beta: `beta-${tag}` },
    secrets,
    objects: { t1, tb },
    matters: { m1, m2, m3, mb },
    acme,
    beta,
    roles: { acmeAdmin, acmeUser, betaAdmin },
    groups: { corpTeam, litTeam, everyone, partyP, betaTeam },
    ana,
    ben,
    cal,
    sue,
    gia,
    dee,
    bob,
  };
}

export type Seed = Awaited<ReturnType<typeof seed>>;
