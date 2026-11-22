// UNVERIFIED against real Okta or Microsoft Entra ID: runs the fixtures in okta.fixtures.ts and
// entra.fixtures.ts over HTTP against createApp. Each scenario gets its own fresh workspace.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { testPool } from "../../test-db.js";
import { scimHarness, seedScim } from "../../test-scim.js";
import { entraScenarios } from "./entra.fixtures.js";
import { oktaScenarios } from "./okta.fixtures.js";
import type { Expected, Scenario } from "./types.js";

const pool = testPool();
afterAll(() => pool.end());

function dig(node: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) return node;
  if (typeof node !== "object" || node === null) return undefined;
  // Extension URNs hold dots, so try the longest key first.
  for (let k = tokens.length; k >= 1; k--) {
    const key = tokens.slice(0, k).join(".");
    if (Object.hasOwn(node, key)) {
      const found = dig((node as Record<string, unknown>)[key], tokens.slice(k));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const fill = <T>(value: T, vars: Record<string, string>): T =>
  JSON.parse(
    JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const v = vars[name];
      if (v === undefined) throw new Error(`fixture uses {{${name}}} before it is saved`);
      return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }),
  ) as T;

function check(actual: unknown, want: Expected, where: string) {
  if (typeof want === "object" && want !== null) {
    if ("$exists" in want) return expect(actual, where).not.toBeUndefined();
    if ("$absent" in want) return expect(actual, where).toBeUndefined();
    if ("$re" in want) return expect(String(actual), where).toMatch(new RegExp(want.$re));
    if ("$len" in want) return expect((actual as unknown[])?.length, where).toBe(want.$len);
    if ("$gte" in want) return expect(actual as number, where).toBeGreaterThanOrEqual(want.$gte);
  }
  expect(actual, where).toEqual(want);
}

async function play(scenario: Scenario) {
  const w = await seedScim(pool, scenario.settings);
  const h = scimHarness(pool);
  const vars: Record<string, string> = { n: randomUUID().slice(0, 8) };
  for (const raw of scenario.steps) {
    const step = fill(raw, vars);
    const qs = step.query ? `?${new URLSearchParams(step.query).toString()}` : "";
    const res = await h.call(w.token, step.method, `${step.path}${qs}`, step.body, step.headers);
    expect(res.status, `${step.name}: status (${JSON.stringify(res.body)})`).toBe(step.status);
    if (res.status !== 204) {
      expect(res.headers.get("content-type"), `${step.name}: content type`).toContain(
        "application/scim+json",
      );
    }
    for (const [path, want] of Object.entries(step.match ?? {})) {
      check(dig(res.body, path.split(".")), want, `${step.name}: ${path}`);
    }
    for (const [name, path] of Object.entries(step.save ?? {})) {
      const v = dig(res.body, path.split("."));
      expect(v, `${step.name}: save ${name}`).not.toBeUndefined();
      vars[name] = String(v);
    }
  }
}

describe("Okta SCIM 2.0 scenarios (UNVERIFIED against real Okta)", () => {
  for (const s of oktaScenarios) it(`${s.name} [${s.source}]`, () => play(s));
});

describe("Microsoft Entra ID scenarios (UNVERIFIED against real Entra)", () => {
  for (const s of entraScenarios) it(`${s.name} [${s.source}]`, () => play(s));
});
