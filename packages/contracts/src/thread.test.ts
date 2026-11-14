import { describe, expect, it } from "vitest";
import { RunEvent } from "./run.js";
import { citationPath, LIMITS, parseCitationPath, ThreadScope } from "./thread.js";

const DOC = "019a5b6e-0000-7000-8000-000000000001";

describe("citation deep links", () => {
  it("round-trips a span", () => {
    const target = { document_id: DOC, version_no: 2, page: 14, char_from: 10, char_to: 42 };
    const path = citationPath(target);
    expect(path).toBe(`/d/${DOC}/v/2?p=14&cf=10&ct=42`);
    expect(parseCitationPath(path)).toEqual(target);
  });

  it("leaves the span out when only half is known", () => {
    expect(citationPath({ document_id: DOC, version_no: 1, page: 3, char_from: 5 })).toBe(
      `/d/${DOC}/v/1?p=3`,
    );
  });

  it("rejects anything else", () => {
    expect(parseCitationPath("/d/not-a-uuid/v/1?p=1")).toBeNull();
    expect(parseCitationPath(`/d/${DOC}/v/1`)).toBeNull();
    expect(parseCitationPath(`/x/${DOC}/v/1?p=1`)).toBeNull();
  });
});

describe("thread scope", () => {
  it("defaults to nothing", () => {
    expect(ThreadScope.parse({})).toEqual({ document_ids: [], vault_ids: [], sources: [] });
  });

  it("enforces the PRD limits", () => {
    const sources = Array.from({ length: LIMITS.sources + 1 }, (_, i) => ({ source_id: `s${i}` }));
    expect(ThreadScope.safeParse({ sources }).success).toBe(false);
    expect(ThreadScope.safeParse({ vault_ids: [DOC, DOC, DOC] }).success).toBe(false);
  });
});

describe("run events", () => {
  it("parses a done event", () => {
    const done = {
      type: "done",
      seq: 9,
      message_id: DOC,
      model: "ollama/qwen3:4b-instruct",
      response_mode: "answer",
      usage: { input_tokens: 10, output_tokens: 4 },
      cost_usd: 0,
      citations: { total: 1, ok: 1, mismatch: 0, unresolved: 0, ungrounded_sentences: 0 },
      duration_ms: 1200,
    };
    expect(RunEvent.parse(done)).toEqual(done);
  });

  it("refuses an unknown type", () => {
    expect(RunEvent.safeParse({ type: "nope", seq: 1 }).success).toBe(false);
  });
});
