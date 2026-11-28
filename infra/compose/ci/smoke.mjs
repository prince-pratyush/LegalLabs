// Smoke test of a running install: health, the web app, sign-in with a second factor, uploads
// through the scanner and the parser, and one question with a verified citation.
import assert from "node:assert/strict";
import { BASE, signIn, until } from "./client.mjs";

const step = (name) => console.log(`ok: ${name}`);

await until(
  async () => (await fetch(`${BASE}/healthz`)).status,
  (status) => status === 200,
  "the proxy and API",
  120_000,
);
step("health, over TLS");

const page = await fetch(`${BASE}/`);
assert.match(page.headers.get("content-type") ?? "", /text\/html/);
assert.ok(page.headers.get("content-security-policy"), "no content security policy");
assert.ok(page.headers.get("strict-transport-security"), "no HSTS");
step("the web app is served with its security headers");

const { post, upload, ask } = await signIn();
step("administrator signed in with a second factor");

const { vault } = await post("/api/v1/vaults", { name: "Smoke" }, 201);
const CONTRACT = `12. Liability
12.1 The Supplier's aggregate liability shall not exceed the fees paid in the twelve months before the claim.
`;
assert.equal((await upload(vault.id, "msa.txt", CONTRACT, "text/plain")).state, "ready");
step("a text file was scanned and read");

const EMAIL = [
  "From: ana@example.test",
  "To: ben@example.test",
  "Subject: Notice period",
  "Date: Mon, 2 Mar 2026 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Either party may terminate on ninety days written notice.",
  "",
].join("\r\n");
assert.equal((await upload(vault.id, "notice.eml", EMAIL, "message/rfc822")).state, "ready");
step("an email was parsed by docproc");

// The industry's harmless test file, split so this script is not itself flagged.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(
  "",
);
assert.equal((await upload(vault.id, "eicar.txt", EICAR, "text/plain")).state, "failed");
step("the malware scanner stopped the test file");

const { stream } = await ask(vault.id, "What is the Supplier's liability cap?");
assert.match(stream, /event: done/);
assert.match(stream, /"verified":"ok"/);
step("a question was answered with a verified citation (stand-in model)");
