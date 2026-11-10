import { describe, expect, it } from "vitest";
import { runIsolated } from "./isolate.js";

const fixture = (name: string) => new URL(`./test-workers/${name}.mjs`, import.meta.url);
const options = { timeoutMs: 3000, maxMemoryMb: 64, maxGrowthMb: 1024 };

describe("runIsolated", () => {
  it("returns what the worker sends", async () => {
    expect(await runIsolated(fixture("echo"), { n: 1 }, options)).toEqual({
      ok: true,
      value: { n: 1 },
    });
  });

  it("gives up on a worker stuck in a loop, without blocking this thread", async () => {
    const started = Date.now();
    const ticks: number[] = [];
    const ticking = setInterval(() => ticks.push(Date.now()), 10);
    const result = await runIsolated(fixture("hang"), null, { ...options, timeoutMs: 100 });
    clearInterval(ticking);
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ticks.length).toBeGreaterThan(2);
  });

  it("reports a worker that throws", async () => {
    expect(await runIsolated(fixture("crash"), null, options)).toEqual({
      ok: false,
      reason: "crashed",
    });
  });

  it("reports a worker that leaves without answering", async () => {
    expect(await runIsolated(fixture("leave"), null, options)).toEqual({
      ok: false,
      reason: "crashed",
    });
  });

  it("stops a worker that fills its heap", async () => {
    expect(await runIsolated(fixture("hungry"), null, { ...options, timeoutMs: 15_000 })).toEqual({
      ok: false,
      reason: "memory",
    });
  });

  it("stops a worker that hoards memory outside its heap", async () => {
    const result = await runIsolated(fixture("hoard"), null, {
      ...options,
      timeoutMs: 15_000,
      maxGrowthMb: 64,
    });
    expect(result).toEqual({ ok: false, reason: "memory" });
  });

  it("gives the worker none of the server's secrets", async () => {
    process.env.ISOLATE_TEST_SECRET = "x";
    const result = await runIsolated(fixture("env"), null, options);
    delete process.env.ISOLATE_TEST_SECRET;
    expect(result).toEqual({ ok: true, value: [] });
  });
});
