import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const H = (v: string) => `sha256('${v}'::text::bytea)`;

// An external Space of Ana's with a party in other.test, not yet approved.
async function externalSpace(tx: Tx, s: Seed, matter: string | null = null) {
  const { id } = await tx.one<{ id: string }>("select core.uuid7() as id");
  await tx.as(s.ana, s.acme);
  await tx.rows(
    `insert into work.space (id, workspace_id, name, kind, matter_id, created_by)
     values ($1, $2, 'Outside deal', 'external', $3, $4)`,
    [id, s.acme, matter, s.ana],
  );
  const { pid } = await tx.one<{ pid: string }>(
    "select work.add_party($1, 'Other LLP', 'other.test', array['lead@other.test']) as pid",
    [id],
  );
  await tx.asOwner();
  return { space: id, party: pid };
}

// Invites and accepts a guest the way the API does: the accept runs before any identity exists.
async function guestJoins(tx: Tx, s: Seed, space: string, email: string, token: string) {
  await tx.as(s.ana, s.acme);
  await tx.rows(`select work.invite_guest($1, $2, ${H(token)}, 90)`, [space, email]);
  await tx.as(null, null);
  const { user_id } = await tx.one<{ user_id: string }>(
    `select * from work.accept_guest_invite(${H(token)}, 'Lee')`,
  );
  await tx.asOwner();
  return user_id;
}

async function approveBoth(tx: Tx, s: Seed, space: string, party: string, guest: string) {
  await tx.as(s.ana, s.acme);
  await tx.rows("select work.approve_connection($1, $2)", [space, party]);
  await tx.as(guest, s.acme);
  await tx.rows("select work.approve_connection($1, $2)", [space, party]);
  await tx.asOwner();
}

async function shareVault(tx: Tx, s: Seed, space: string, party: string, level: string | null) {
  await tx.as(s.ana, s.acme);
  await tx.rows(
    `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id, access, per_party, granted_by)
     values ($1, $2, 'vault', $3, 'view', $4::jsonb, $5)`,
    [s.acme, space, s.vaults.acme.vaultId, level ? JSON.stringify({ [party]: level }) : "{}", s.ana],
  );
  await tx.asOwner();
}

async function count(tx: Tx, s: Seed, user: string, sql: string) {
  await tx.as(user, s.acme);
  const { n } = await tx.one<{ n: string }>(`select count(*) as n from ${sql}`);
  await tx.asOwner();
  return Number(n);
}

describe("guests", () => {
  it("sees no row of any table except the few opened for them", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const tables = await tx.rows<{ t: string }>(
        `select n.nspname || '.' || quote_ident(c.relname) as t
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relrowsecurity and c.relkind in ('r', 'p') and not c.relispartition
            and n.nspname in ('core','work','content','admin','knowledge','notify','analytics','retention','memory')
            and has_table_privilege('legallabs_app', c.oid, 'select')
          order by 1`,
      );
      const opened = new Set([
        "core.user", "core.workspace", "core.session", "work.space", "work.space_member",
        "work.space_resource", "work.space_party", "work.space_connection", "content.vault",
      ]);
      const leaks: string[] = [];
      await tx.as(s.gia, s.acme);
      for (const { t } of tables) {
        if (opened.has(t.replace(/"/g, ""))) continue;
        const { n } = await tx.one<{ n: string }>(`select count(*) as n from ${t}`);
        if (Number(n) > 0) leaks.push(t);
      }
      expect(leaks).toEqual([]);
    });
  });

  it("sees none of the internal Spaces, vaults, matters or people", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      for (const t of ["work.space", "content.vault", "core.matter", "work.space_resource"]) {
        expect(await count(tx, s, s.gia, t)).toBe(0);
      }
      expect(await count(tx, s, s.gia, "core.user")).toBe(1);
      expect(await count(tx, s, s.gia, "core.workspace")).toBe(1);
    });
  });

  it("cannot create or change anything", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      const inserts = [
        `insert into content.vault (workspace_id, owner_id, name) values ('${s.acme}', '${s.gia}', 'x')`,
        `insert into work.space (workspace_id, name, created_by) values ('${s.acme}', 'x', '${s.gia}')`,
        `insert into work.thread (workspace_id, owner_id, title) values ('${s.acme}', '${s.gia}', 'x')`,
      ];
      for (const q of inserts) {
        expect(await tx.error(q)).toMatch(/row-level security|permission denied/);
      }
      await tx.rows(`update core."user" set name = 'hax' where id = '${s.gia}'`);
      await tx.asOwner();
      expect(await tx.rows(`select 1 from core."user" where name = 'hax'`)).toEqual([]);
      await tx.as(s.gia, s.acme);
      expect((await tx.one("select core.has_permission('threads.use') as p")).p).toBe(false);
      expect((await tx.one("select core.has_permission('spaces.create') as p")).p).toBe(false);
    });
  });

  it("cannot probe definer helpers", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      expect((await tx.one("select work.vault_walled($1) as w", [s.vaults.acme.vaultId])).w).toBe(false);
      expect(await tx.rows("select * from work.space_directory()")).toEqual([]);
      expect(await tx.rows("select * from work.space_guests($1)", [s.guestRooms.acme.spaceId])).toEqual([]);
    });
  });

  it("gets nothing from direct, group or workspace shares", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      for (const [pt, pid] of [
        ["user", s.gia],
        ["group", s.groups.partyP],
        ["workspace", s.acme],
      ]) {
        await tx.rows(
          `insert into core.share_grant (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
           values ($1, 'vault', $2, $3, $4, 'full', $5)`,
          [s.acme, s.vaults.acme.vaultId, pt, pid, s.ana],
        );
      }
      await tx.as(s.gia, s.acme);
      expect((await tx.one("select core.has_access('vault', $1, 'view') as a", [s.vaults.acme.vaultId])).a).toBe(false);
      expect(await tx.rows("select id from content.vault")).toEqual([]);
    });
  });

  describe("external Space flow", () => {
    it("rejects an invite outside the party's domain and an existing member's address", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space } = await externalSpace(tx, s);
        await tx.as(s.ana, s.acme);
        expect(await tx.error(`select work.invite_guest($1, 'x@elsewhere.test', ${H("a")})`, [space])).toMatch(/GUEST_DOMAIN_MISMATCH/);
        expect(await tx.error("select work.add_party($1, 'Two', 'two.test')", [space])).toMatch(/PARTY_LIMIT/);
        await tx.asOwner();
        await tx.rows(`insert into core."user" (workspace_id, email, status, kind) values ($1, 'm@other.test', 'active', 'member')`, [s.acme]);
        await tx.as(s.ana, s.acme);
        expect(await tx.error(`select work.invite_guest($1, 'm@other.test', ${H("b")})`, [space])).toMatch(/EMAIL_IS_MEMBER/);
      });
    });

    it("needs the right permission and an admin to run the flow", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        await tx.as(s.ben, s.acme);
        expect(await tx.error(`select work.invite_guest($1, 'a@other.test', ${H("c")})`, [space])).toMatch(/FORBIDDEN/);
        expect(await tx.error("select work.approve_connection($1, $2)", [space, party])).toMatch(/FORBIDDEN/);
        await tx.as(s.gia, s.acme);
        expect(await tx.error("select work.approve_connection($1, $2)", [space, party])).toMatch(/FORBIDDEN/);
      });
    });

    it("shows nothing outward before both sides approve", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t1");
        await tx.as(s.ana, s.acme);
        expect(
          await tx.error(
            `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id, access, per_party, granted_by)
             values ($1, $2, 'vault', $3, 'view', $4::jsonb, $5)`,
            [s.acme, space, s.vaults.acme.vaultId, JSON.stringify({ [party]: "view" }), s.ana],
          ),
        ).toMatch(/CONNECTION_NOT_APPROVED/);
        await tx.asOwner();
        expect(await count(tx, s, guest, "work.space")).toBe(0);
        await tx.as(s.ana, s.acme);
        expect((await tx.one("select work.approve_connection($1, $2) as st", [space, party])).st).toBe("in_progress");
        expect(await tx.error("select work.approve_connection($1, $2)", [space, party])).toMatch(/ALREADY_APPROVED/);
        await tx.asOwner();
        expect(await count(tx, s, guest, "work.space")).toBe(0);
        await tx.as(guest, s.acme);
        expect((await tx.one("select work.approve_connection($1, $2) as st", [space, party])).st).toBe("resolved");
        await tx.asOwner();
        expect(await count(tx, s, guest, "work.space")).toBe(1);
      });
    });

    it("reaches a vault only at the party's level, never the default, never above edit", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t2");
        await approveBoth(tx, s, space, party, guest);
        await shareVault(tx, s, space, party, null);
        expect(await count(tx, s, guest, "content.vault")).toBe(0);
        expect(await count(tx, s, guest, "work.space_resource")).toBe(0);
        await tx.asOwner();
        await tx.rows("update work.space_resource set per_party = $1::jsonb where space_id = $2", [JSON.stringify({ [party]: "view" }), space]);
        expect(await count(tx, s, guest, "content.vault")).toBe(1);
        await tx.as(guest, s.acme);
        expect((await tx.one("select core.has_access('vault', $1, 'edit') as a", [s.vaults.acme.vaultId])).a).toBe(false);
        await tx.asOwner();
        await tx.rows("update work.space_resource set per_party = $1::jsonb where space_id = $2", [JSON.stringify({ [party]: "full" }), space]);
        await tx.as(guest, s.acme);
        expect((await tx.one("select core.has_access('vault', $1, 'edit') as a", [s.vaults.acme.vaultId])).a).toBe(true);
        expect((await tx.one("select core.has_access('vault', $1, 'full') as a", [s.vaults.acme.vaultId])).a).toBe(false);
        expect(await tx.rows("select id from content.document")).toEqual([]);
        await tx.asOwner();
        await tx.rows("update work.space_resource set per_party = $1::jsonb where space_id = $2", [JSON.stringify({ [party]: "none" }), space]);
        expect(await count(tx, s, guest, "content.vault")).toBe(0);
      });
    });

    it("still obeys walls", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s, s.matters.m1);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t3");
        await approveBoth(tx, s, space, party, guest);
        // No allow row for the guest on the Space's matter: the Space is dead to them.
        expect(await count(tx, s, guest, "work.space")).toBe(0);
        await tx.rows(
          `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
           values ($1, $2, 'user', $3, 'allow')`,
          [s.acme, s.matters.m1, guest],
        );
        expect(await count(tx, s, guest, "work.space")).toBe(1);
        // The vault's own matter is walled separately.
        await shareVault(tx, s, space, party, "view");
        await tx.rows("update content.vault set matter_id = $1 where id = $2", [s.matters.m2, s.vaults.acme.vaultId]);
        expect(await count(tx, s, guest, "content.vault")).toBe(0);
        // A deny on their party's group shuts the Space again.
        await tx.rows(
          `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
           values ($1, $2, 'group', $3, 'deny')`,
          [s.acme, s.matters.m1, s.groups.partyP],
        );
        await tx.rows("insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)", [s.acme, s.groups.partyP, guest]);
        expect(await count(tx, s, guest, "work.space")).toBe(0);
      });
    });

    it("locks an expired guest out of everything at once", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t4");
        await approveBoth(tx, s, space, party, guest);
        await shareVault(tx, s, space, party, "view");
        expect(await count(tx, s, guest, "content.vault")).toBe(1);
        await tx.rows(
          `insert into core.session (workspace_id, user_id, token_hash, expires_at)
           values ($1, $2, sha256('tok'::text::bytea), now() + interval '1 hour')`,
          [s.acme, guest],
        );
        expect((await tx.rows("select * from core.resolve_session(sha256('tok'::text::bytea))")).length).toBe(1);
        await tx.rows("update core.guest_profile set expires_at = now() - interval '1 second' where user_id = $1", [guest]);
        for (const t of ["content.vault", "work.space", "work.space_resource", "core.user", "core.workspace"]) {
          expect(await count(tx, s, guest, t)).toBe(0);
        }
        await tx.as(guest, s.acme);
        expect((await tx.one("select core.has_access('vault', $1, 'view') as a", [s.vaults.acme.vaultId])).a).toBe(false);
        expect(await tx.rows("select * from work.my_guest_spaces()")).toEqual([]);
        await tx.asOwner();
        expect(await tx.rows("select * from core.resolve_session(sha256('tok'::text::bytea))")).toEqual([]);
        expect((await tx.one(`select issued from core.issue_guest_code($1, 'lead@other.test', ${H("c1")})`, [s.slugs.acme])).issued).toBe(false);
      });
    });

    it("loses access when the party's domain changes or it is rejected", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t5");
        await approveBoth(tx, s, space, party, guest);
        expect(await count(tx, s, guest, "work.space")).toBe(1);
        await tx.as(s.ana, s.acme);
        await tx.rows("select work.set_party_domain($1, $2, 'new.test')", [space, party]);
        await tx.asOwner();
        expect(await count(tx, s, guest, "work.space")).toBe(0);
        expect((await tx.one("select status from work.space_connection where party_id = $1", [party])).status).toBe("action_required");
        await tx.as(s.ana, s.acme);
        await tx.rows("select work.reject_connection($1, $2, 'no')", [space, party]);
        await tx.asOwner();
        expect((await tx.one("select status from work.space_connection where party_id = $1", [party])).status).toBe("rejected");
      });
    });

    it("locks out after five wrong codes, and a right code is spent once", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t6");
        await approveBoth(tx, s, space, party, guest);
        const slug = s.slugs.acme;
        await tx.as(null, null);
        expect((await tx.one(`select issued from core.issue_guest_code($1, 'lead@other.test', ${H("good")})`, [slug])).issued).toBe(true);
        expect((await tx.one(`select issued from core.issue_guest_code($1, 'nobody@other.test', ${H("good")})`, [slug])).issued).toBe(false);
        expect((await tx.one(`select ok from core.verify_guest_code($1, 'lead@other.test', ${H("good")})`, [slug])).ok).toBe(true);
        expect((await tx.one(`select ok from core.verify_guest_code($1, 'lead@other.test', ${H("good")})`, [slug])).ok).toBe(false);
        await tx.rows(`select * from core.issue_guest_code($1, 'lead@other.test', ${H("good2")})`, [slug]);
        for (let i = 0; i < 5; i++) {
          await tx.rows(`select * from core.verify_guest_code($1, 'lead@other.test', ${H("bad")})`, [slug]);
        }
        const r = await tx.one(`select ok, reason from core.verify_guest_code($1, 'lead@other.test', ${H("good2")})`, [slug]);
        expect(r).toEqual({ ok: false, reason: "locked" });
      });
    });

    it("keeps guests out of other Spaces and other workspaces", async () => {
      await withTx(async (tx) => {
        const s = await seed(tx);
        const { space, party } = await externalSpace(tx, s);
        const guest = await guestJoins(tx, s, space, "lead@other.test", "t7");
        await approveBoth(tx, s, space, party, guest);
        await tx.as(guest, s.acme);
        const seen = await tx.rows<{ id: string }>("select id from work.space");
        expect(seen.map((r) => r.id)).toEqual([space]);
        await tx.as(guest, s.beta);
        expect(await tx.rows("select id from work.space")).toEqual([]);
        expect(await tx.rows('select id from core."user"')).toEqual([]);
      });
    });
  });
});
