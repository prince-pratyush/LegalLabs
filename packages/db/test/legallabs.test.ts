import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { run } from "../src/legallabs.js";

const canonicalOf = (seq: number) =>
  JSON.stringify({
    workspace_id: "w1",
    seq,
    at: "2026-11-01T00:00:00.000000Z",
    actor_type: "system",
    actor_id: null,
    action: "retention.sweep",
    object_type: null,
    object_id: null,
    details: {},
    ip: null,
    ua_hash: null,
  });

function chainFile(length: number): { text: string; last: string } {
  let prev = "00".repeat(32);
  const lines: string[] = [];
  for (let seq = 1; seq <= length; seq++) {
    const canonical = canonicalOf(seq);
    const hash = createHash("sha256")
      .update(Buffer.from(prev, "hex"))
      .update(canonical, "utf8")
      .digest("hex");
    lines.push(JSON.stringify({ ...JSON.parse(canonical), prev_hash: prev, hash, canonical }));
    prev = hash;
  }
  return { text: lines.join("\n"), last: prev };
}

async function cli(args: string[], files: Record<string, string> = {}, databaseUrl?: string) {
  const out: string[] = [];
  const code = await run(args, {
    readFile: (path) => files[path] ?? "",
    print: (line) => out.push(line),
    databaseUrl,
  });
  return { code, out: out.join("\n") };
}

describe("legallabs audit verify", () => {
  it("passes an untouched file", async () => {
    const result = await cli(["audit", "verify", "e.jsonl"], { "e.jsonl": chainFile(3).text });
    expect(result).toEqual({ code: 0, out: "ok: 3 events verified" });
  });

  it("fails and names the event for an edited line", async () => {
    const text = chainFile(2).text.replace(`"seq":2`, `"seq":9`);
    const { code, out } = await cli(["audit", "verify", "e.jsonl"], { "e.jsonl": text });
    expect(code).toBe(1);
    expect(out).toMatch(/event 9/);
  });

  it("checks anchors when given them", async () => {
    const { text } = chainFile(2);
    const anchors = JSON.stringify({ day: "2026-11-01", last_seq: 2, last_hash: "ff".repeat(32) });
    const { code, out } = await cli(["audit", "verify", "e.jsonl", "a.jsonl"], {
      "e.jsonl": text,
      "a.jsonl": anchors,
    });
    expect(code).toBe(1);
    expect(out).toMatch(/anchor/);
  });

  it("does not call an empty file verified", async () => {
    expect((await cli(["audit", "verify", "e.jsonl"], { "e.jsonl": "" })).code).toBe(1);
  });

  it("explains itself when called wrongly", async () => {
    const { code, out } = await cli(["audit"]);
    expect(code).toBe(2);
    expect(out).toMatch(/usage/);
  });
});

describe("legallabs audit export", () => {
  it("writes a chain that verify accepts", async () => {
    const url = inject("databaseUrl");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `insert into core.workspace (slug, name, region)
       values ('cli-' || core.uuid7(), 'cli', 'au') returning id`,
    );
    const workspace = rows[0]?.id ?? "";
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspace]);
    await client.query("select admin.append_audit_event('retention.sweep', 'system', null)");
    await client.query("commit");
    await client.end();

    const exported = await cli(["audit", "export", workspace], {}, url);
    expect(exported.code).toBe(0);
    const verified = await cli(["audit", "verify", "e.jsonl"], { "e.jsonl": exported.out });
    expect(verified).toEqual({ code: 0, out: "ok: 1 events verified" });
  });
});
