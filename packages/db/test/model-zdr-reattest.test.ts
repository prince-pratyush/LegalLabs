import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";
import { withTx } from "./db.js";

const sql = () => readFileSync(join(migrationsFolder, "0297_admin_model_zdr_reattest.sql"), "utf8");

describe("0297: zero retention is declared again for hosted models", () => {
  it("clears what earlier code stamped on hosted rows, and leaves local ones", async () => {
    await withTx(async (tx) => {
      const { id } = await tx.one<{ id: string }>(
        "insert into core.workspace (slug, name, region) values ('zdr-reattest', 'z', 'au') returning id",
      );
      await tx.rows(
        `insert into admin.model_config (workspace_id, provider, model, region, zdr) values
           ($1, 'anthropic', 'claude', 'unspecified', true),
           ($1, 'google', 'gemini', 'eu', true),
           ($1, 'ollama', 'qwen', 'unspecified', true),
           ($1, 'local', 'vllm', 'local', true)`,
        [id],
      );

      await tx.rows(sql());

      const rows = await tx.rows(
        "select provider, zdr from admin.model_config where workspace_id = $1 order by provider",
        [id],
      );
      expect(rows).toEqual([
        { provider: "anthropic", zdr: false },
        { provider: "google", zdr: false },
        { provider: "local", zdr: true },
        { provider: "ollama", zdr: true },
      ]);
      const forced = await tx.one(
        "select relforcerowsecurity f from pg_class where oid = 'admin.model_config'::regclass",
      );
      expect(forced).toEqual({ f: true });
    });
  });
});
