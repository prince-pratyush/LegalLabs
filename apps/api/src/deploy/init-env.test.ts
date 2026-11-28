import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unsafeSettings } from "./posture.js";

const script = fileURLToPath(new URL("../../../../infra/compose/init-env.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "legallabs-env-"));

const run = (file: string, ...args: string[]) =>
  execFileSync("sh", [script, ...args], {
    env: { ...process.env, ENV_FILE: file },
    encoding: "utf8",
    stdio: "pipe",
  });
const parse = (file: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

describe("init-env.sh", () => {
  it("writes secrets only its owner can read, prints none, and passes the boot checks", () => {
    const file = join(dir, "a.env");
    const printed = run(file, "legal.example.test", "ops@example.test");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const env = parse(file);
    for (const [name, value] of Object.entries(env)) {
      if (name !== "LEGALLABS_DOMAIN" && name !== "LEGALLABS_TLS") {
        expect(printed).not.toContain(value);
      }
    }
    expect(
      unsafeSettings({
        ...env,
        DATABASE_URL: `postgres://legallabs_api:${env.LEGALLABS_DB_PASSWORD}@postgres/legallabs`,
        LEGALLABS_PUBLIC_URL: `https://${env.LEGALLABS_DOMAIN}`,
      }),
    ).toEqual([]);
  });

  it("never overwrites, because the old keys sealed data", () => {
    const file = join(dir, "b.env");
    run(file, "localhost", "internal");
    const before = readFileSync(file, "utf8");
    expect(() => run(file, "localhost", "internal")).toThrow(/already exists/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it.each([
    ["https://legal.example.test", "internal"],
    ["legal.example.test", "nobody"],
    ["legal.example.test", "a@b.test\nPOSTGRES_PASSWORD=x"],
  ])("refuses a domain or email that is not one (%s)", (domain, tls) => {
    expect(() => run(join(dir, "c.env"), domain, tls)).toThrow();
  });
});
