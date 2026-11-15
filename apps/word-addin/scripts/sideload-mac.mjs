// Puts a development manifest where Word for Mac looks for add-ins, then Word shows
// LegalLabs under Home > Add-ins > My Add-ins (Developer). Run it from your own terminal:
// macOS only lets apps you've approved write inside Word's folder.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const origin = (process.env.ADDIN_ORIGIN ?? "https://localhost:3000").replace(/\/+$/, "");
const wef = join(homedir(), "Library/Containers/com.microsoft.Word/Data/Documents/wef");
const template = readFileSync(new URL("../manifest.template.xml", import.meta.url), "utf8");
mkdirSync(wef, { recursive: true });
const out = join(wef, "legallabs.xml");
writeFileSync(out, template.replaceAll("{{ORIGIN}}", origin));
console.log(`LegalLabs manifest for ${origin} is in ${out}. Restart Word to load it.`);
