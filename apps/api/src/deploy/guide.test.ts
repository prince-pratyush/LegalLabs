import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The install guide promises every setting. This reads the code that ships and holds it to that.

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|py)$/.test(path) && !/(\.test\.ts|\/test-[^/]*|\/testing\.ts)$/.test(path)
      ? [path]
      : [];
  });
}

const READS =
  /(?:\benv(?:\.|\["|\.get\(")|environ(?:\.get\(|\.setdefault\()"|need\(")([A-Z][A-Z0-9_]{3,})/g;

const shipped = [
  "apps/api/src",
  ...readdirSync(join(root, "packages"))
    // The evaluation harness is not part of a deployment.
    .filter((name) => name !== "eval")
    .map((name) => `packages/${name}/src`),
  "services/docproc/src",
];

describe("docs/deploy/install.md", () => {
  const guide = read("docs/deploy/install.md");
  const missing = (names: Iterable<string>) =>
    [...new Set(names)].filter((name) => !guide.includes(`\`${name}\``)).sort();

  it("names every setting the code reads", () => {
    const names = shipped
      .flatMap(sources)
      .flatMap((path) => [...read(path).matchAll(READS)].map((m) => m[1] as string));
    expect(names.length).toBeGreaterThan(30);
    expect(missing(names)).toEqual([]);
  });

  it("names every setting the compose file takes", () => {
    const names = [...read("infra/compose/compose.yaml").matchAll(/(?<!\$)\$\{([A-Z0-9_]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(missing(names)).toEqual([]);
  });
});
