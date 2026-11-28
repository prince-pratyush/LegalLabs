import type { Api } from "@legallabs/addin";
import { describe, expect, it } from "vitest";
import { fakeHost } from "../test/fake-host.js";
import { batches, MAX_BATCH_CHARS, offsetOf, proofread, translate } from "./tools.js";

const apiOf = (handler: (path: string, body: { paragraphs: string[] }) => unknown): Api => ({
  get: async () => {
    throw new Error("unused");
  },
  post: async <T>(path: string, body?: unknown) =>
    handler(path, body as { paragraphs: string[] }) as T,
  upload: async () => {
    throw new Error("unused");
  },
});

describe("batches", () => {
  it("skips empty paragraphs, keeps indexes, and splits by size", () => {
    const big = "x".repeat(MAX_BATCH_CHARS);
    const plan = batches(["a", "", big, "b", "y".repeat(MAX_BATCH_CHARS + 1)]);
    expect(plan.skipped).toBe(1);
    expect(plan.batches.map((b) => b.indexes)).toEqual([[0], [2], [3]]);
  });
});

describe("offsetOf", () => {
  it("places a selection only when it fits in one place", () => {
    expect(offsetOf(["a", "b", "c"], ["b", "c"])).toBe(1);
    expect(offsetOf(["a", "b", "a", "b"], ["a", "b"])).toBeNull();
    expect(offsetOf(["a"], [])).toBeNull();
  });
});

describe("proofread", () => {
  it("anchors fixes to document paragraphs, and they apply", async () => {
    const fake = fakeHost(["Title", "This Agreement is goverened by law."]);
    const api = apiOf(() => ({
      suggestions: [{ paragraph: 1, before: "goverened", after: "governed", reason: "Spelling" }],
    }));
    const steps: number[] = [];
    const { cards } = await proofread(api, fake.host, "document", (done) => steps.push(done));
    expect(cards[0]).toMatchObject({
      kind: "proofread",
      title: "Spelling",
      anchor: { paragraph_index: 1 },
    });
    expect(steps).toEqual([0, 1]);
    const card = cards[0];
    if (!card) throw new Error("no card");
    expect(await fake.host.apply(card, true)).toEqual({ ok: true });
    expect(fake.paragraphs[1]).toBe("This Agreement is governed by law.");
  });
});

describe("translate", () => {
  it("writes back what came back and counts what didn't", async () => {
    const fake = fakeHost(["One", "", "Two"]);
    const api = apiOf((_, body) => ({
      paragraphs: body.paragraphs.map((p) => (p === "One" ? "Un" : null)),
    }));
    const out = await translate(api, fake.host, "document", "French", true, () => {});
    expect(out).toEqual({ changed: 1, missed: 1, skipped: 0 });
    expect(fake.log.rewrites[0]).toEqual({
      scope: "document",
      edits: [{ index: 0, text: "Un" }],
      track: true,
    });
  });
});
