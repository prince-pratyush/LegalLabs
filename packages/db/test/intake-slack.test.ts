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
  "apps.file_slack_event(gen_random_uuid(), gen_random_uuid(), 'U1', 'a', null, null, 0)",
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
