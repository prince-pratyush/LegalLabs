import type { ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { testPool } from "../test-db.js";
import { matterHarness } from "../test-matters.js";

const pool = testPool();
afterAll(() => pool.end());

const model: ModelProvider = {
  complete: async () => ({
    text: "The rent is 1200 a month.",
    usage: { input_tokens: 100, output_tokens: 20 },
  }),
};
const h = matterHarness(pool, { anthropic: model }, true);

describe("exporting a draft of a thread that read a vault", () => {
  it.each(["document_ids", "vault_ids"] as const)(
    "follows the vault's controls when it was asked by %s",
    async (by) => {
      const admin = await h.workspace();
      const ana = await h.member(admin, "ana");
      const made = await h.call(admin, "POST", "/vaults", { name: "Leases" });
      const vaultId = made.body.vault.id as string;
      const added = await h.postFile(admin, `/vaults/${vaultId}/files`, "l.txt", "Rent is 1200.");
      await h.drain(admin);
      await h.call(admin, "PUT", `/vaults/${vaultId}/shares`, {
        grants: [{ principal_type: "user", principal_id: ana.userId, level: "view" }],
        workspace_view: false,
      });
      const res = await h.call(ana, "POST", "/threads", {
        content: "What is the rent?",
        scope: { [by]: [by === "vault_ids" ? vaultId : added.body.file.id] },
      });
      expect(res.status).toBe(202);
      await h.threads.threads.settled();
      // The vault then leaves the scope: its words are still in the conversation.
      if (by === "vault_ids") {
        await pool.query("update work.thread set vault_ids = '{}' where id = $1", [
          res.body.thread_id,
        ]);
      }
      const draft = await h.call(ana, "POST", `/threads/${res.body.thread_id}/drafts`, {
        kind: "editor",
      });
      const exported = () =>
        h.app.request(`/api/v1/drafts/${draft.body.draft.id}/export`, {
          headers: { cookie: ana.cookie },
        });
      expect((await exported()).status).toBe(200);
      await pool.query(
        `update content.vault set content_controls = content_controls || '{"allow_download": false}'
          where id = $1`,
        [vaultId],
      );
      const refused = await exported();
      expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([
        403,
        "EXPORT_DISABLED",
      ]);
    },
  );
});
