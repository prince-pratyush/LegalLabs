// Writes the add-in manifest for one origin: the server Outlook loads the pane from.
// ADDIN_ORIGIN=https://legal.example.com [ADDIN_ID=<guid>] node scripts/manifest.mjs [--out path]
import { readFileSync, writeFileSync } from "node:fs";

const origin = (process.env.ADDIN_ORIGIN ?? "https://localhost:3001").replace(/\/+$/, "");
// The characters of a host and port only, so nothing can leave its place in the XML.
if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
  console.error(`ADDIN_ORIGIN must be an https origin, not ${origin}`);
  process.exit(1);
}
// One per deployment: two deployments with the same id replace each other in a mailbox.
const id = process.env.ADDIN_ID ?? "7d3a4c52-9b1e-4f0a-8c61-2e5f7a9d4b13";
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
  console.error(`ADDIN_ID must be a GUID, not ${id}`);
  process.exit(1);
}
const at = process.argv.indexOf("--out");
const out = at > -1 ? process.argv[at + 1] : "dist/manifest.xml";
const template = readFileSync(new URL("../manifest.template.xml", import.meta.url), "utf8");
writeFileSync(out, template.replaceAll("{{ORIGIN}}", origin).replaceAll("{{ID}}", id));
console.log(`manifest for ${origin} written to ${out}`);
