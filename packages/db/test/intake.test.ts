import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

/*
 * Intake: requests come from people with no account, so a service user per workspace owns their
 * files in an Inbox vault. Triage staff read it by permission; matter walls still apply.
 */

const count = async (tx: Tx, sql: string, params: unknown[] = []) =>
  Number((await tx.one<{ n: string }>(`select count(*) n from ${sql}`, params)).n);

/** A member of acme who holds the given permissions. */
async function staff(tx: Tx, s: Seed, name: string, permissions: string[]) {
  await tx.asOwner();
  const role = await tx.one<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [s.acme, name, permissions],
  );
  const user = await tx.one<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [s.acme, `${name}@acme.test`, role.id],
  );
  return user.id;
}

const inbox = async (tx: Tx, s: Seed, who: string) => {
  await tx.as(who, s.acme);
  return tx.one<{ service_user_id: string; vault_id: string }>(
    "select * from apps.ensure_intake_inbox()",
  );
};

/** A request made the way the API makes one. */
async function request(tx: Tx, s: Seed, who: string, matter: string | null = null) {
  await tx.as(who, s.acme);
  const { id: requester } = await tx.one<{ id: string }>(
    "select apps.intake_requester_id('api', $1, 'Jo', null) id",
    [`jo-${Math.random()}`],
  );
  return tx.one<{ id: string; number: number }>(
    `insert into apps.intake_request (workspace_id, channel, external_ref, requester_id,
       requester_name, status, matter_id, created_by)
     values ($1, 'api', core.uuid7()::text, $2, 'Jo', 'unclassified', $3, $4)
     returning id, number`,
    [s.acme, requester, matter, who],
  );
}

/** A file in the Inbox vault, put there as the service user. */
async function inboxFile(tx: Tx, s: Seed, service: string, vault: string, parent?: string) {
  await tx.as(service, s.acme);
  const doc = await tx.one<{ id: string }>(
    `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id, parent_id)
     values ($1, $2, 'nda.txt', 'text/plain', 10, $3, $4) returning id`,
    [s.acme, service, vault, parent ?? null],
  );
  const version = await tx.one<{ id: string }>(
    `insert into content.document_version (workspace_id, document_id, sha256, created_by)
     values ($1, $2, sha256('x'), $3) returning id`,
    [s.acme, doc.id, service],
  );
  await tx.rows("insert into content.ingest_job (workspace_id, version_id) values ($1, $2)", [
    s.acme,
    version.id,
  ]);
  return doc.id;
}

/** Records, as whoever is acting, that a file was sent in by a person. */
const claim = (tx: Tx, s: Seed, who: string, document: string) =>
  tx.error(
    "insert into apps.intake_attachment (workspace_id, document_id, added_by) values ($1, $2, $3)",
    [s.acme, document, who],
  );

/** An Inbox file added for a person, as the upload does it: one step, as the service user. */
async function added(tx: Tx, s: Seed, who: string, service: string, vault: string) {
  const doc = await inboxFile(tx, s, service, vault);
  expect(await claim(tx, s, who, doc)).toBeUndefined();
  return doc;
}

describe("the intake inbox", () => {
  it("is one service user and one vault per workspace, made on first use", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows("delete from apps.intake_inbox where workspace_id = $1", [s.acme]);
      const triage = await staff(tx, s, "tri", ["intake.triage"]);
      const first = await inbox(tx, s, triage);
      expect(await inbox(tx, s, s.ana)).toEqual(first);
      await tx.asOwner();
      const user = await tx.one(
        `select kind, status, role_id, extra_permissions from core."user" where id = $1`,
        [first.service_user_id],
      );
      expect(user).toEqual({
        kind: "service",
        status: "active",
        role_id: null,
        extra_permissions: [],
      });
      const vault = await tx.one("select owner_id, matter_id from content.vault where id = $1", [
        first.vault_id,
      ]);
      expect(vault).toEqual({ owner_id: first.service_user_id, matter_id: null });
    });
  });

  it("refuses to make one for someone without an intake permission", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await tx.error("select * from apps.ensure_intake_inbox()")).toMatch(/not allowed/);
    });
  });

  it("lets its service user read files and nothing else", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { service_user_id: service } = await inbox(tx, s, s.ana);
      await tx.as(service, s.acme);
      const can = async (p: string) =>
        (await tx.one<{ ok: boolean }>("select core.has_permission($1) ok", [p])).ok;
      expect(await can("threads.use")).toBe(true);
      for (const p of ["vaults.create", "intake.triage", "intake.manage", "admin.config"]) {
        expect({ p, ok: await can(p) }).toEqual({ p, ok: false });
      }
      // Only this workspace's own vault: no share, no ownership anywhere else.
      expect(await count(tx, "content.vault where id = $1", [s.vaults.acme.vaultId])).toBe(0);
    });
  });

  it("is read by triage staff, who can change nothing in it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const triage = await staff(tx, s, "tri", ["intake.triage", "threads.use"]);
      const manager = await staff(tx, s, "mgr", ["intake.manage", "threads.use"]);
      const { service_user_id: service, vault_id: vault } = await inbox(tx, s, triage);
      const doc = await inboxFile(tx, s, service, vault);

      await tx.as(triage, s.acme);
      const level = await tx.one("select content.vault_level($1) l", [vault]);
      expect(level).toEqual({ l: "view" });
      expect(await count(tx, "content.vault where id = $1", [vault])).toBe(1);
      // A file with no row of its own is read like any other in the vault.
      expect(await count(tx, "content.document where id = $1", [doc])).toBe(1);
      const renamed = await tx.rows(
        "update content.document set name = 'x' where id = $1 returning id",
        [doc],
      );
      expect(renamed).toEqual([]);
      expect(
        await tx.error("select content.trash_items($1, array[$2]::uuid[], '{}')", [vault, doc]),
      ).toMatch(/not allowed/);
      expect(await tx.error("select content.set_vault_shares($1, '[]', true)", [vault])).toMatch(
        /not allowed/,
      );
      expect(await tx.error("select content.trash_vault($1)", [vault])).toMatch(/not allowed/);

      for (const outsider of [s.ben, manager, s.gia]) {
        await tx.as(outsider, s.acme);
        expect(await count(tx, "content.document where id = $1", [doc])).toBe(0);
        expect(
          await count(
            tx,
            "content.page p join content.document_version v on v.id = p.version_id where v.document_id = $1",
            [doc],
          ),
        ).toBe(0);
      }
    });
  });

  it("cannot be taken over by an administrator", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { service_user_id: service, vault_id: vault } = await inbox(tx, s, s.ana);
      await tx.as(s.ana, s.acme);
      expect(await tx.one("select content.transfer_vault($1, $2) ok", [vault, s.ana])).toEqual({
        ok: false,
      });
      expect(
        await tx.error(`update core."user" set status = 'deprovisioned' where id = $1`, [service]),
      ).toMatch(/intake/);
      expect(
        await tx.error(`update core."user" set email = 'ana2@acme.test' where id = $1`, [service]),
      ).toMatch(/intake/);
      expect(
        await tx.error(
          `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
           values ($1, $2, 't', sha256('t'), '{vaults:read}', now() + interval '1 day')`,
          [s.acme, service],
        ),
      ).toMatch(/intake/);
    });
  });
});

describe("who can see an intake request", () => {
  it("shows it, its requester and its timeline to triage staff only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const triage = await staff(tx, s, "tri", ["intake.triage"]);
      const manager = await staff(tx, s, "mgr", ["intake.manage"]);
      const made = await request(tx, s, triage);
      await tx.rows(
        `insert into apps.intake_event (workspace_id, request_id, kind, actor_type, actor_id)
         values ($1, $2, 'inbound', 'user', $3)`,
        [s.acme, made.id, triage],
      );
      expect(await count(tx, "apps.intake_request where id = $1", [made.id])).toBe(1);
      for (const outsider of [s.ben, manager, s.gia]) {
        await tx.as(outsider, s.acme);
        expect(await count(tx, "apps.intake_request where id = $1", [made.id])).toBe(0);
        expect(await count(tx, "apps.intake_event where request_id = $1", [made.id])).toBe(0);
        expect(await count(tx, "apps.intake_requester")).toBe(0);
      }
    });
  });

  it("hides a matter's request and files from staff walled off from it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // M2 is open to members but denies cal.
      await tx.asOwner();
      await tx.rows(
        `update core.role set permissions = '{threads.use,intake.triage}' where id = $1`,
        [s.roles.acmeUser],
      );
      const { service_user_id: service, vault_id: vault } = await inbox(tx, s, s.ana);
      const doc = await added(tx, s, s.ben, service, vault);
      const made = await request(tx, s, s.ben, s.matters.m2);
      await tx.rows("update apps.intake_attachment set request_id = $2 where document_id = $1", [
        doc,
        made.id,
      ]);
      // What ingest spawns from a mailbox follows its source.
      const child = await inboxFile(tx, s, service, vault, doc);

      await tx.as(s.cal, s.acme);
      expect(await count(tx, "apps.intake_request where id = $1", [made.id])).toBe(0);
      expect(await count(tx, "apps.intake_requester")).toBe(1);
      expect(await count(tx, "apps.intake_attachment where request_id = $1", [made.id])).toBe(0);
      expect(await count(tx, "content.document where id = any($1)", [[doc, child]])).toBe(0);
      expect(
        await tx.rows(
          "update apps.intake_request set status = 'triaged' where id = $1 returning id",
          [made.id],
        ),
      ).toEqual([]);

      await tx.as(s.ben, s.acme);
      expect(await count(tx, "content.document where id = any($1)", [[doc, child]])).toBe(2);
      // The worker must still be able to read what the service user owns.
      await tx.as(service, s.acme);
      expect(await count(tx, "content.document where id = any($1)", [[doc, child]])).toBe(2);
    });
  });

  it("keeps a file that isn't attached yet to the person adding it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const one = await staff(tx, s, "one", ["intake.triage", "threads.use"]);
      const two = await staff(tx, s, "two", ["intake.triage", "threads.use"]);
      const { service_user_id: service, vault_id: vault } = await inbox(tx, s, one);
      const doc = await added(tx, s, one, service, vault);
      await tx.as(one, s.acme);
      expect(await count(tx, "content.document where id = $1", [doc])).toBe(1);
      await tx.as(two, s.acme);
      expect(await count(tx, "content.document where id = $1", [doc])).toBe(0);
      expect(await claim(tx, s, two, doc)).toBeDefined();
      // Nor can it be hung on someone else's request.
      const theirs = await request(tx, s, two);
      expect(
        await tx.rows(
          "update apps.intake_attachment set request_id = $2 where document_id = $1 returning 1",
          [doc, theirs.id],
        ),
      ).toEqual([]);
    });
  });

  it("lets only the service user record a file, and only one in the Inbox", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { service_user_id: service, vault_id: vault } = await inbox(tx, s, s.ana);
      const doc = await inboxFile(tx, s, service, vault);
      // A person can see the Inbox but can't claim what is in it, even as themselves.
      await tx.as(s.ana, s.acme);
      expect(await claim(tx, s, s.ana, doc)).toMatch(/row-level security/);
      await tx.as(service, s.acme);
      expect(await claim(tx, s, s.ana, s.vaults.acme.documentId)).toMatch(/row-level security/);
      expect(await claim(tx, s, s.ana, s.documents.acme.documentId)).toMatch(/row-level security/);
      expect(await claim(tx, s, s.gia, doc)).toMatch(/row-level security/);
    });
  });
});

describe("what a request will accept", () => {
  it("numbers requests per workspace and ignores a chosen number", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const first = await request(tx, s, s.ana);
      const second = await request(tx, s, s.ana);
      expect(second.number).toBe(first.number + 1);
      await tx.as(s.bob, s.beta);
      await tx.rows("select apps.intake_requester_id('api', 'x', 'X', null)");
      await tx.asOwner();
      const beta = await tx.one<{ n: number }>(
        "select max(number) n from apps.intake_request where workspace_id = $1",
        [s.beta],
      );
      expect(beta.n).toBe(1);
      await tx.as(s.ana, s.acme);
      const forced = await tx.one<{ number: number }>(
        `insert into apps.intake_request (workspace_id, number, channel, external_ref, requester_id,
           requester_name, status, created_by)
         select $1, 999, 'api', 'forced', requester_id, 'Jo', 'unclassified', $2
           from apps.intake_request where id = $3 returning number`,
        [s.acme, s.ana, first.id],
      );
      expect(forced.number).toBe(second.number + 1);
    });
  });

  it("limits updates to the columns triage may change", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const made = await request(tx, s, s.ana);
      for (const set of [
        "number = 7",
        "channel = 'slack'",
        "external_ref = 'x'",
        "requester_name = 'x'",
        "requester_email = 'x@y.test'",
        "requester_id = requester_id",
        "fields = '{}'",
        "matter_id = null",
        "created_by = null",
        "created_at = now()",
      ]) {
        expect(
          await tx.error(`update apps.intake_request set ${set} where id = $1`, [made.id]),
        ).toMatch(/permission denied/);
      }
      for (const table of ["intake_request", "intake_event", "intake_attachment"]) {
        expect(await tx.error(`delete from apps.${table}`)).toMatch(/permission denied/);
      }
      expect(await tx.error("update apps.intake_event set details = '{}'")).toMatch(
        /permission denied/,
      );
    });
  });

  it("assigns only triage staff who can open the request", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const triage = await staff(tx, s, "tri", ["intake.triage"]);
      const made = await request(tx, s, s.ana, s.matters.m2);
      const assign = (who: string) =>
        tx.error("update apps.intake_request set assignee_id = $2 where id = $1", [made.id, who]);
      expect(await assign(triage)).toBeUndefined();
      for (const bad of [s.ben, s.sue, s.gia]) expect(await assign(bad)).toMatch(/assignee/);
      await tx.asOwner();
      await tx.rows(
        `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
         values ($1, $2, 'user', $3, 'deny')`,
        [s.acme, s.matters.m2, triage],
      );
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update apps.intake_request set assignee_id = null where id = $1", [
          made.id,
        ]),
      ).toBeUndefined();
      expect(await assign(triage)).toMatch(/assignee/);
    });
  });

  it("never changes a finished request", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const made = await request(tx, s, s.ana);
      await tx.rows(
        "update apps.intake_request set status = 'closed', closed_reason = 'spam' where id = $1",
        [made.id],
      );
      expect(
        await tx.error(
          "update apps.intake_request set status = 'triaged', closed_reason = null where id = $1",
          [made.id],
        ),
      ).toMatch(/finished/);
    });
  });

  it("starts empty: no assignee, outcome or other channel", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const made = await request(tx, s, s.ana);
      const forge = (columns: string, values: string) =>
        tx.error(
          `insert into apps.intake_request (workspace_id, external_ref, requester_id,
             requester_name, created_by, ${columns})
           select $1, core.uuid7()::text, requester_id, 'Jo', $2, ${values}
             from apps.intake_request where id = $3`,
          [s.acme, s.ana, made.id],
        );
      expect(await forge("channel, status", "'slack', 'new'")).toMatch(/row-level security/);
      expect(await forge("channel, status", "'api', 'triaged'")).toMatch(/row-level security/);
      expect(await forge("channel, status, assignee_id", `'api', 'new', '${s.ana}'`)).toMatch(
        /row-level security/,
      );
    });
  });

  it("lets only managers change request types", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const triage = await staff(tx, s, "tri", ["intake.triage"]);
      const manager = await staff(tx, s, "mgr", ["intake.manage"]);
      const add = (who: string, name: string) =>
        tx.error(
          `insert into apps.intake_request_type (workspace_id, name, fields, sla_hours, created_by)
           values ($1, $2, '[]', 8, $3)`,
          [s.acme, name, who],
        );
      await tx.as(manager, s.acme);
      expect(await add(manager, "NDA review")).toBeUndefined();
      await tx.as(triage, s.acme);
      expect(await add(triage, "Other")).toMatch(/row-level security/);
      expect(await count(tx, "apps.intake_request_type where name = 'NDA review'")).toBe(1);
      expect(await tx.rows("update apps.intake_request_type set name = 'x' returning id")).toEqual(
        [],
      );
      await tx.as(s.ben, s.acme);
      expect(await count(tx, "apps.intake_request_type")).toBe(0);
    });
  });
});
