import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type AuthorityRecord, contentHash } from "./record.js";
import type { Loader } from "./sources.js";
import { createFileLoader, type SyncSummary, sync, type Writer } from "./sync.js";

const record = (ref: string, text = "Synthetic text."): AuthorityRecord => ({
  ref,
  title: "Synthetic authority",
  citations: [],
  sections: [],
  meta: {},
  chunks: [{ sectionPath: null, text }],
});

function memoryWriter() {
  const stored = new Map<string, string>();
  const finished: SyncSummary[] = [];
  const writer: Writer = {
    async upsert(r) {
      const hash = contentHash(r);
      const before = stored.get(r.ref);
      stored.set(r.ref, hash);
      if (before === undefined) return "added";
      return before === hash ? "unchanged" : "updated";
    },
    async finish(_source, summary) {
      finished.push(summary);
    },
  };
  return { writer, stored, finished };
}

const loaderOf = (items: unknown[]): Loader => ({
  source: "eurlex",
  async *records() {
    for (const item of items) yield item as AuthorityRecord;
  },
});

describe("sync", () => {
  it("counts what changed and skips what did not", async () => {
    const { writer, finished } = memoryWriter();
    const first = await sync(
      loaderOf([record("eurlex:celex:1"), record("eurlex:celex:2")]),
      writer,
    );
    expect(first).toMatchObject({ added: 2, updated: 0, unchanged: 0, failed: [] });
    const second = await sync(
      loaderOf([record("eurlex:celex:1"), record("eurlex:celex:2", "Changed.")]),
      writer,
    );
    expect(second).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(finished).toHaveLength(2);
  });

  it("keeps going past a failed item and a record from another source", async () => {
    const { writer, stored } = memoryWriter();
    const summary = await sync(
      loaderOf([
        { failed: "x", reason: "gone" },
        record("edgar:accession:0000000001-24-000001"),
        { ...record("eurlex:celex:3"), title: "" },
        record("eurlex:celex:4"),
      ]),
      writer,
    );
    expect(summary.failed.map((f) => f.failed)).toEqual([
      "x",
      "edgar:accession:0000000001-24-000001",
      "eurlex:celex:3",
    ]);
    expect([...stored.keys()]).toEqual(["eurlex:celex:4"]);
  });

  it("records a writer error against the item, not the run", async () => {
    const writer: Writer = {
      upsert: async () => {
        throw new Error("disk full");
      },
      finish: async () => {},
    };
    const summary = await sync(loaderOf([record("eurlex:celex:5")]), writer);
    expect(summary.failed).toEqual([{ failed: "eurlex:celex:5", reason: "Error: disk full" }]);
  });
});

describe("createFileLoader", () => {
  const folder = mkdtempSync(join(tmpdir(), "knowledge-files-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("reads single records and lists, and names the bad ones", async () => {
    writeFileSync(join(folder, "a.json"), JSON.stringify(record("edgar:accession:1")));
    writeFileSync(
      join(folder, "b.json"),
      JSON.stringify([record("edgar:accession:2"), { ref: "nope" }]),
    );
    writeFileSync(join(folder, "c.json"), "{ not json");
    writeFileSync(join(folder, "notes.txt"), "ignored");
    const seen: string[] = [];
    for await (const item of createFileLoader("edgar", folder).records()) {
      seen.push("failed" in item ? `failed ${item.failed}` : item.ref);
    }
    expect(seen).toEqual([
      "edgar:accession:1",
      "edgar:accession:2",
      "failed b.json#1",
      "failed c.json",
    ]);
  });

  it("loads the same files twice with nothing new the second time", async () => {
    const { writer } = memoryWriter();
    await sync(createFileLoader("edgar", folder), writer);
    const again = await sync(createFileLoader("edgar", folder), writer);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
  });
});
