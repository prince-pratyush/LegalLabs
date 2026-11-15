import type { CompleteCall } from "@legallabs/review";
import { describe, expect, it } from "vitest";
import { fakeComplete, makeClient, sameModel } from "./clients.ts";
import { buildContract } from "./generate.ts";
import { checkOoxml, engineHash, reviewContract, ruleId } from "./run.ts";

const call = (task: CompleteCall["task"], prompt: string): CompleteCall => ({
  task,
  system: "s",
  prompt,
  json: true,
  maxTokens: 100,
});

describe("fake client", () => {
  it("answers every task with JSON the engine accepts", () => {
    expect(JSON.parse(fakeComplete(call("extract", "x")).text)).toEqual({});
    expect(JSON.parse(fakeComplete(call("verify", "x")).text)).toEqual({ gaps: [] });
    const draft = JSON.parse(
      fakeComplete(
        call(
          "draft",
          "Rule\n<doc-ab12>\n[7] (2. Term) One two three four five six seven.\n</doc-ab12>",
        ),
      ).text,
    );
    expect(draft.evidence[0]).toEqual({ p: 7, quote: "two three four five six seven." });
  });

  it("refuses paid clients without their key", () => {
    expect(() => makeClient({ client: "anthropic", env: {} })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => makeClient({ client: "openai", env: {} })).toThrow(/OPENAI_API_KEY/);
  });

  it("sends Ollama JSON mode with the configured window", async () => {
    let sent: { format?: string; options?: { num_ctx?: number } } = {};
    const fetchStub = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ message: { content: "{}" }, prompt_eval_count: 12, eval_count: 3 }),
      );
    }) as unknown as typeof fetch;
    const { complete } = makeClient({ client: "ollama", numCtx: 4096, fetch: fetchStub, env: {} });
    const r = await complete(call("extract", "x"));
    expect(sent.format).toBe("json");
    expect(sent.options?.num_ctx).toBe(4096);
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });
});

describe("reviewContract", () => {
  it("reviews a generated contract offline and patches its suggestions", async () => {
    const { bytes, gold } = buildContract("nda", 3, 21, "t");
    const { complete, model } = makeClient({ client: "fake" });
    const r = await reviewContract(bytes, { template: "nda", complete, model });
    expect(r.outcome.results).toHaveLength(gold.rules.length);
    expect(r.existing_edits).toBeGreaterThan(0);
    expect(r.outcome.gaps.some((g) => g.kind === "existing_edit")).toBe(true);
    expect(r.ooxml.valid).toBe(r.ooxml.applied);
    expect(r.ooxml.combined.reread_ok).toBe(true);
    expect(r.pages).toBeGreaterThanOrEqual(3);
  });

  it("counts a suggestion whose text is not in the paragraph as an anchor failure", async () => {
    const { bytes } = buildContract("msa", 3, 4, "t");
    const { complete, model } = makeClient({ client: "fake" });
    const r = await reviewContract(bytes, { template: "msa", complete, model });
    const f = r.outcome.results[0];
    if (!f) throw new Error("no findings");
    const bad = {
      ...r.outcome,
      results: [
        {
          ...f,
          suggestion: {
            id: "s1",
            rule_id: f.rule_id,
            anchor: { paragraph_index: 2, char_from: 0, char_to: 1, para_hash: "x" },
            kind: "replace" as const,
            before: "words that are nowhere",
            after: "new words",
            justification: "j",
            status: "pending" as const,
          },
        },
      ],
    };
    const check = checkOoxml(bytes, bad);
    expect(check).toMatchObject({ suggestions: 1, applied: 0, failed: { ANCHOR_FAILED: 1 } });
  });
});

describe("reproducibility", () => {
  it("accepts only the pinned model, its gateway id or a dated snapshot", () => {
    expect(sameModel("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(true);
    expect(sameModel("anthropic/claude-haiku-5-5", "anthropic/claude-haiku-5-5")).toBe(true);
    expect(sameModel("gpt-5.5", "gpt-5.5-2026-10-01")).toBe(true);
    expect(sameModel("claude-sonnet-5-5", "claude-sonnet-5")).toBe(false);
    expect(sameModel("gpt-5.5", "gpt-5.5-mini")).toBe(false);
    expect(sameModel("anthropic/claude-haiku-5-5", "google/gemini-3.6-flash")).toBe(false);
  });

  it("derives rule ids from the template and title, and hashes the engine", async () => {
    expect(ruleId("nda", "Residuals")).toBe(ruleId("nda", "Residuals"));
    expect(ruleId("nda", "Residuals")).not.toBe(ruleId("msa", "Residuals"));
    expect(ruleId("nda", "Residuals")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(engineHash()).toMatch(/^[0-9a-f]{64}$/);
    const { bytes } = buildContract("nda", 3, 2, "t");
    const { complete, model } = makeClient({ client: "fake" });
    const r = await reviewContract(bytes, { template: "nda", complete, model });
    expect(r.answered_models).toEqual(["fake"]);
  });
});
