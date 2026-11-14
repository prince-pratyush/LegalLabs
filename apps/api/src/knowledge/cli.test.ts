import { describe, expect, it } from "vitest";
import { type KnowledgeIo, run } from "./cli.js";

const io = (env: KnowledgeIo["env"], files: Record<string, string> = {}) => {
  const printed: string[] = [];
  const value: KnowledgeIo = {
    env,
    embedder: null,
    readFile: async (path) => {
      const body = files[path];
      if (body === undefined) throw new Error("missing");
      return body;
    },
    print: (line) => printed.push(line),
  };
  return { value, printed };
};

describe("legallabs-knowledge", () => {
  it("prints usage for an unknown command or source", async () => {
    for (const args of [[], ["sync"], ["sync", "bailii"], ["load", "edgar"], ["drop", "edgar"]]) {
      const { value, printed } = io({ DATABASE_URL: "postgres://x" });
      expect(await run(args, value)).toBe(2);
      expect(printed[0]).toMatch(/^usage:/);
    }
  });

  it("needs a database", async () => {
    const { value, printed } = io({});
    expect(await run(["sync", "eurlex"], value)).toBe(2);
    expect(printed).toEqual(["failed: DATABASE_URL is not set"]);
  });

  it("will not sync EDGAR without a declared User-Agent", async () => {
    const { value, printed } = io({ DATABASE_URL: "postgres://x" });
    expect(await run(["sync", "edgar"], value)).toBe(2);
    expect(printed[0]).toMatch(/SEC_USER_AGENT/);
  });

  it("refuses a subset file in the wrong shape", async () => {
    const files = { "s.json": JSON.stringify({ eurlex: { celex: ["not celex"] } }), "b.json": "{" };
    for (const path of ["s.json", "b.json", "missing.json"]) {
      const { value, printed } = io({ DATABASE_URL: "postgres://x" }, files);
      expect(await run(["sync", "eurlex", path], value)).toBe(1);
      expect(printed[0]).toMatch(/subset file/);
    }
  });
});
