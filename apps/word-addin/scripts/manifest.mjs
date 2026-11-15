// Writes the add-in manifest for one origin: the server Word loads the pane from.
// ADDIN_ORIGIN=https://legal.example.com node scripts/manifest.mjs [--out path]
import { readFileSync, writeFileSync } from "node:fs";

const origin = (process.env.ADDIN_ORIGIN ?? "https://localhost:3000").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(origin)) {
  console.error(`ADDIN_ORIGIN must be an https origin, not ${origin}`);
  process.exit(1);
}
const at = process.argv.indexOf("--out");
const out = at > -1 ? process.argv[at + 1] : "dist/manifest.xml";
const template = readFileSync(new URL("../manifest.template.xml", import.meta.url), "utf8");
writeFileSync(out, template.replaceAll("{{ORIGIN}}", origin));
console.log(`manifest for ${origin} written to ${out}`);
