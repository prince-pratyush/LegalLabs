import { describe, expect, it } from "vitest";
import { until, useStack } from "./session.js";

// Real features driven through the built server, then read back through the analytics API after
// a rollup. Nothing here writes an event itself: a feature that stops recording fails this.
const { call, json, post, events, asOwner, token } = useStack();

const CONTRACT = `MASTER SERVICES AGREEMENT

12. Liability
12.1 The Supplier's aggregate liability shall not exceed the fees paid in the twelve months before the claim.

13. Termination
13.1 Either party may terminate this agreement on ninety days written notice.
`;

type UserRow = Record<string, number | string>;
const refresh = () => post("/api/v1/admin/analytics/refresh", {});

const shared = { vault: "", file: "", thread: "", table: "" };
const scope = () => ({ document_ids: [], vault_ids: [shared.vault], sources: [] });

describe("Command Center counts real work", { concurrent: false }, () => {
  it("asks in a new thread, follows up, and asks once from the Word pane", async () => {
    const { vault } = await post<{ vault: { id: string } }>(
      "/api/v1/vaults",
      { name: "Analytics deal room" },
      201,
    );
    shared.vault = vault.id;
    const form = new FormData();
    form.set("file", new File([CONTRACT], "msa.txt", { type: "text/plain" }));
    const { file } = await json<{ file: { id: string } }>(
      `/api/v1/vaults/${vault.id}/files`,
      { method: "POST", body: form },
      202,
    );
    shared.file = file.id;
    await until(
      () => json<{ files: { id: string; state: string }[] }>(`/api/v1/vaults/${vault.id}/tree`),
      (t) => t.files.find((f) => f.id === file.id)?.state === "ready",
      "the upload to be read",
    );

    const asked = await post<{ thread_id: string; run_id: string }>(
      "/api/v1/threads",
      { content: "What is the liability cap?", scope: scope() },
      202,
    );
    shared.thread = asked.thread_id;
    await events(asked.run_id);
    const again = await post<{ run_id: string }>(
      `/api/v1/threads/${asked.thread_id}/messages`,
      { content: "And the notice period?", scope: scope() },
      202,
    );
    await events(again.run_id);

    // The pane holds the session token and sends it as a bearer header.
    const pane = await json<{ run_id: string }>(
      "/api/v1/threads",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token()}` },
        body: JSON.stringify({ content: "Summarise termination.", scope: scope() }),
      },
      202,
    );
    await events(pane.run_id);
  });

  it("runs an agent, but not its test run", async () => {
    const { agent } = await post<{ agent: { id: string } }>(
      "/api/v1/agents",
      { title: "Notice checker", mode: "scratch" },
      201,
    );
    await post(
      `/api/v1/agents/${agent.id}/versions`,
      { instructions: "Report the notice period.", promote: true },
      201,
    );
    await post(`/api/v1/agents/${agent.id}/run`, { inputs: "Go." }, 202);
    await post(`/api/v1/agents/${agent.id}/test`, { inputs: "Try." }, 202);
  });

  it("runs a review table column and downloads the table twice", async () => {
    const { table } = await post<{ table: { id: string } }>(
      "/api/v1/review-tables",
      {
        name: "Analytics table",
        source: { kind: "vault", vault_id: shared.vault, document_ids: [shared.file] },
      },
      201,
    );
    shared.table = table.id;
    const base = `/api/v1/review-tables/${table.id}`;
    const { column } = await post<{ column: { id: string } }>(
      `${base}/columns`,
      { label: "Notice", type: "number", prompt: "How many days of written notice?" },
      201,
    );
    await post(`${base}/columns/${column.id}/run`, { scope: "all" }, 202);
    await until(
      () => json<{ columns: { state: string }[] }>(base),
      (t) => t.columns.every((c) => c.state !== "running"),
      "the column to finish",
    );
    for (let i = 0; i < 2; i++) {
      const res = await call(`${base}/export`, {
        method: "POST",
        body: JSON.stringify({ format: "csv" }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
  });

  it("shows all of it after a rollup", async () => {
    await refresh();
    const { rows } = await json<{ rows: UserRow[] }>("/api/v1/admin/analytics/users");
    expect(rows.find((r) => r.email === "pilot@example.test")).toMatchObject({
      active_days: 1,
      threads: 1,
      follow_ups: 1,
      word: 1,
      agent_runs: 1,
      rt_columns: 1,
    });
    const overview = await json<{
      productUsageBySurface: { surfaces: { surface: string; users: number }[] };
    }>("/api/v1/admin/analytics/overview");
    expect(
      overview.productUsageBySurface.surfaces.filter((s) => s.users > 0).map((s) => s.surface),
    ).toEqual(["web", "word", "review_tables", "agents"]);
    const report = await json<{
      queriesOverTime: { series: { with_sources: number; without_sources: number }[] };
    }>("/api/v1/admin/analytics/report");
    const total = (key: "with_sources" | "without_sources") =>
      report.queriesOverTime.series.reduce((n, day) => n + day[key], 0);
    // The agent reads nothing of its own; everything else read the vault or its file.
    expect([total("with_sources"), total("without_sources")]).toEqual([4, 1]);
    const outcomes = await json<{ workflows: { workflow_type: string; count: number }[] }>(
      "/api/v1/admin/analytics/outcomes",
    );
    expect(outcomes.workflows).toMatchObject([{ workflow_type: "table_exported", count: 1 }]);
  });

  it("keeps ids and counts only", async () => {
    const stored = await asOwner<{ row: string }>(
      "select row_to_json(e)::text as row from analytics.usage_event e",
    );
    expect(stored.length).toBeGreaterThan(0);
    for (const { row } of stored) {
      expect(row).not.toMatch(/liability|notice|termination|msa\.txt|deal room|pilot@/i);
    }
  });
});
