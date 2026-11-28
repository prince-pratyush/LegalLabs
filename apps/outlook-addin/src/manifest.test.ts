// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/manifest.mjs", import.meta.url));

function build(env: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), "manifest-")), "manifest.xml");
  execFileSync(process.execPath, [script, "--out", out], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  return readFileSync(out, "utf8");
}

describe("the mail manifest", () => {
  const xml = build({ ADDIN_ORIGIN: "https://legal.example.com/" });

  it("points every address at the deployment's own host", () => {
    const addresses = [...xml.matchAll(/(?:DefaultValue="|<AppDomain>)(https?:[^"<]+)/g)];
    expect(addresses.length).toBeGreaterThan(5);
    for (const [, url] of addresses) expect(url).toMatch(/^https:\/\/legal\.example\.com(\/|$)/);
    expect(xml).not.toContain("{{");
  });

  it("asks to read the open message and nothing more", () => {
    expect(xml).toContain('xsi:type="MailApp"');
    expect(xml).toContain("<Permissions>ReadItem</Permissions>");
    expect(xml).not.toMatch(/ReadWrite|SendMode|LaunchEvent|OnMessageSend/);
    expect(xml).toContain('xsi:type="MessageReadCommandSurface"');
  });

  it("takes the deployment's own id, and refuses an origin that isn't https", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(build({ ADDIN_ID: id })).toContain(`<Id>${id}</Id>`);
    expect(() => build({ ADDIN_ORIGIN: "http://legal.example.com" })).toThrow();
    expect(() => build({ ADDIN_ORIGIN: 'https://a.com"/><x' })).toThrow();
    expect(() => build({ ADDIN_ID: "<x/>" })).toThrow();
  });
});
