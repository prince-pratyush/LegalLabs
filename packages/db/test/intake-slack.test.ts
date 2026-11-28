import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

/*
 * Intake from Slack: what it adds is for the worker's functions only, the two kinds of channel
 * stay apart, and a thread is only its own requester's.
 */

const FUNCTIONS = [
  "apps.open_slack_channel('x')",
  "apps.receive_slack_event(gen_random_uuid(), 'x', null, null, null, null)",
  "apps.slack_thread_request(gen_random_uuid(), 'C1', '1.1', 'U1')",
  "apps.claim_slack_event(60, 600, 10)",
  "apps.file_slack_event(gen_random_uuid(), gen_random_uuid(), 'U1', 'a', null, null, 0, null, false)",
  "apps.append_slack_reply(gen_random_uuid(), gen_random_uuid(), 'U1', 'C1', '1.1', 0)",
  "apps.claim_slack_post(60, 1, 1)",
  "apps.sent_slack_post(gen_random_uuid(), gen_random_uuid(), 'C1', '1.1')",
];

describe("intake from Slack in the database", () => {
  it("gives the app role neither the threads nor the functions", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select 1 from apps.slack_thread")).toMatch(/permission denied/);
      for (const call of FUNCTIONS) {
        expect(await tx.error(`select ${call}`)).toMatch(/permission denied/);
      }
    });
  });

  it("opens each kind of channel only for its own hook", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      const keys = await tx.rows<{ kind: string; key: string }>(
        "select kind, key from apps.intake_channel",
      );
      await tx.asWorker();
      for (const { kind, key } of keys) {
        const open = async (fn: string) =>
          (await tx.rows(`select * from apps.${fn}($1)`, [key])).length;
        expect(await open("open_email_channel")).toBe(kind === "email" ? 1 : 0);
        expect(await open("open_slack_channel")).toBe(kind === "slack" ? 1 : 0);
      }
    });
  });

  it("counts what each kind has taken in an hour on its own", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const channel = (kind: string) =>
        tx.one<{ id: string }>(
          "select id from apps.intake_channel where kind = $1 and workspace_id = $2",
          [kind, s.acme],
        );
      const [email, slack] = [await channel("email"), await channel("slack")];
      const add = (id: string, status: "queued" | "accepted", mark: string) =>
        tx.rows(
          `insert into apps.inbound_email
             (workspace_id, channel_id, event_hash, size_bytes, status, raw, processed_at)
           values ($1, $2, sha256(convert_to($3, 'utf8')), 1, $4,
                   case when $4 = 'queued' then 'x'::bytea end,
                   case when $4 = 'accepted' then now() end)`,
          [s.acme, id, mark, status],
        );
      const claims = async (sql: string) => {
        await tx.rows("update apps.inbound_email set next_attempt_at = now() - interval '1s'");
        await tx.asWorker();
        const rows = await tx.rows(sql, [[s.acme]]);
        await tx.asOwner();
        return rows.length;
      };
      const mail = "select * from apps.claim_inbound_email(60, 2, 10, $1)";
      const posts = "select * from apps.claim_slack_event(60, 2, 10, $1)";
      await add(slack.id, "queued", "s");
      await add(slack.id, "accepted", "s1");
      await add(slack.id, "accepted", "s2");
      // Slack has had its two; mail has had none.
      expect(await claims(posts)).toBe(0);
      expect(await claims(mail)).toBe(1);
      await tx.rows("delete from apps.inbound_email where status = 'accepted'");
      await add(email.id, "accepted", "m1");
      await add(email.id, "accepted", "m2");
      expect(await claims(mail)).toBe(0);
      expect(await claims(posts)).toBe(1);
    });
  });

  it("keeps each kind of channel to its own settings", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      expect(
        await tx.error("update apps.intake_channel set address = 'a@b.test' where kind = 'slack'"),
      ).toMatch(/intake_channel_shape/);
      expect(
        await tx.error("update apps.intake_channel set team_id = 'T0002' where kind = 'email'"),
      ).toMatch(/intake_channel_shape/);
    });
  });
});
