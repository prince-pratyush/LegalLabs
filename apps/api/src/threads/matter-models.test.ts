import type { ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { testPool } from "../test-db.js";
import { matterHarness } from "../test-matters.js";

const pool = testPool();
afterAll(() => pool.end());

let calls = 0;
const model: ModelProvider = {
  complete: async () => {
    calls++;
    return {
      text: 'Rent is due.<c doc="D1" page="1" quote="Rent is due"/>',
      usage: { input_tokens: 100, output_tokens: 20 },
    };
  },
};
const h = matterHarness(pool, { anthropic: model });

async function matterRoom() {
  const admin = await h.workspace();
  const made = await h.call(admin, "POST", "/matters", {
    client_id: "C1",
    client_name: "Acme",
    matter_number: "M-1",
    matter_name: "Sealed",
  });
  const matterId = made.body.matter.id as string;
  const file = await h.postFile(admin, "/documents", "a.txt", "Rent is due.", {
    matter_id: matterId,
  });
  await h.drain(admin);
  const documentId = file.body.document.id as string;
  const deny = () =>
    pool.query("update core.matter set model_policy = $2 where id = $1", [
      matterId,
      JSON.stringify({ deny_providers: ["anthropic"] }),
    ]);
  const ask = async (extra: object = {}, threadId?: string) => {
    const res = await h.call(
      admin,
      "POST",
      threadId ? `/threads/${threadId}/messages` : "/threads",
      { content: "What is due?", scope: { document_ids: [documentId] }, ...extra },
    );
    await h.threads.threads.settled();
    return res;
  };
  return { admin, matterId, documentId, deny, ask };
}

describe("a matter's model policy in threads", () => {
  it("refuses an answer, a file and a deep analysis when no model is left", async () => {
    const r = await matterRoom();
    await r.deny();
    calls = 0;
    for (const extra of [{}, { output_format: "docx" }, { deep_analysis: true }]) {
      const res = await r.ask(extra);
      expect([res.status, res.body.code]).toEqual([403, "MODEL_NOT_ALLOWED"]);
    }
    expect(calls).toBe(0);
  });

  it("applies a policy set after a deep plan was made", async () => {
    const r = await matterRoom();
    const res = await r.ask({ deep_analysis: true });
    await r.deny();
    calls = 0;
    await h.call(r.admin, "POST", `/runs/${res.body.run_id}/approve`);
    await h.threads.threads.settled();
    expect(calls).toBe(0);
    const run = (await h.call(r.admin, "GET", `/runs/${res.body.run_id}`)).body.run;
    expect(run.status).toBe("failed");
  });

  it("applies to rewriting the thread's drafts", async () => {
    const r = await matterRoom();
    const res = await r.ask();
    const draft = await h.call(r.admin, "POST", `/threads/${res.body.thread_id}/drafts`, {
      kind: "editor",
    });
    await r.deny();
    calls = 0;
    const edit = await h.call(r.admin, "POST", `/drafts/${draft.body.draft.id}/edit`, {
      instruction: "Shorter",
    });
    expect([edit.status, edit.body.code]).toEqual([403, "MODEL_NOT_ALLOWED"]);
    expect(calls).toBe(0);
  });
});
