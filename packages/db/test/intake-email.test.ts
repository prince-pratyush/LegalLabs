import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

/*
 * Intake by email: the queue belongs to functions only the worker may call, and what arrives
 * can neither make a user nor reach anyone before it is a request.
 */

const FUNCTIONS = [
  "apps.open_email_channel('x')",
  "apps.receive_inbound_email(gen_random_uuid(), 'x')",
  "apps.claim_inbound_email(60, 600, 10)",
  "apps.begin_inbound_email(gen_random_uuid(), gen_random_uuid(), 'a', 'b', 1)",
  "apps.inbound_email_parts(gen_random_uuid())",
  "apps.postpone_inbound_email(gen_random_uuid(), gen_random_uuid(), 1, true)",
  "apps.refuse_inbound_email(gen_random_uuid(), gen_random_uuid(), 'failed', 'x')",
  "apps.end_inbound_email(gen_random_uuid(), 'failed', 'x')",
  "apps.file_inbound_email(gen_random_uuid(), gen_random_uuid(), 'a', 'a@b.test', 0)",
];

describe("intake email in the database", () => {
  it("gives the app role neither the queue nor its functions, whoever it acts for", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select 1 from apps.inbound_email")).toMatch(/permission denied/);
      for (const call of FUNCTIONS) {
        expect(await tx.error(`select ${call}`)).toMatch(/permission denied/);
      }
    });
  });

  it("gives the worker its functions and nothing to read directly", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      await tx.asWorker();
      for (const table of ["apps.inbound_email", "apps.intake_channel", "apps.intake_request"]) {
        expect(await tx.error(`select 1 from ${table}`)).toMatch(/permission denied/);
      }
    });
  });

  it("shows a channel only to those who manage intake in its workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const count = async () =>
        Number((await tx.one<{ n: string }>("select count(*) n from apps.intake_channel")).n);
      await tx.as(s.bob, s.acme);
      expect(await count()).toBe(0);
      await tx.asOwner();
      const outsider = await tx.one<{ id: string }>(
        `insert into core."user" (workspace_id, email, status)
         values ($1, 'plain@acme.test', 'active') returning id`,
        [s.acme],
      );
      await tx.as(outsider.id, s.acme);
      expect(await count()).toBe(0);
    });
  });

  it("holds no content once a message is no longer waiting", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      expect(
        await tx.error("update apps.inbound_email set status = 'accepted' where raw is not null"),
      ).toMatch(/check constraint/);
    });
  });

  it("keeps a file that came by email from everyone until its request exists", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { serviceId, vaultId } = s.intakes.acme;
      const email = await tx.one<{ id: string }>(
        "select id from apps.inbound_email where workspace_id = $1",
        [s.acme],
      );
      const add = async () => {
        await tx.as(serviceId, s.acme);
        const doc = await tx.one<{ id: string }>(
          `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id)
           values ($1, $2, 'in.txt', 'text/plain', 1, $3) returning id`,
          [s.acme, serviceId, vaultId],
        );
        return doc.id;
      };
      const link = `insert into apps.intake_attachment
          (workspace_id, document_id, inbound_email_id, part_no) values ($1, $2, $3, $4)`;
      const first = await add();
      await tx.rows(link, [s.acme, first, email.id, 1]);
      // The same part is never filed twice.
      const second = await add();
      expect(await tx.error(link, [s.acme, second, email.id, 1])).toMatch(/unique/);
      // Nobody but the service account may say a file came by email.
      await tx.as(s.ana, s.acme);
      expect(await tx.error(link, [s.acme, second, email.id, 2])).toMatch(/row-level security/);
      await tx.rows("select set_config('legallabs.intake_read', 'on', true)");
      expect(await tx.rows("select 1 from content.document where id = $1", [first])).toEqual([]);
      expect(
        await tx.rows("select 1 from apps.intake_attachment where document_id = $1", [first]),
      ).toEqual([]);
    });
  });
});
