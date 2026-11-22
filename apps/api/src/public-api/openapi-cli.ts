#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { PublicApi } from "@legallabs/contracts";

// The committed spec lives at the repo root so readers and SDK generators find it without a build.
export const SPEC_PATH = new URL("../../../../docs/api/openapi.json", import.meta.url);

export const renderSpec = () => `${JSON.stringify(PublicApi.buildOpenApi(), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode === "--write") {
    writeFileSync(SPEC_PATH, renderSpec());
    console.log("docs/api/openapi.json written");
  } else if (mode === "--check") {
    let committed = "";
    try {
      committed = readFileSync(SPEC_PATH, "utf8");
    } catch {}
    if (committed !== renderSpec()) {
      console.error(
        "docs/api/openapi.json is out of date. Run: pnpm --filter @legallabs/api openapi:write",
      );
      process.exit(1);
    }
    console.log("docs/api/openapi.json matches the code");
  } else {
    console.error("usage: openapi-cli --write | --check");
    process.exit(2);
  }
}
