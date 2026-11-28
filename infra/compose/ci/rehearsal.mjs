// The backup and restore rehearsal's product side: `seed` before the backup, `delete` after
// it, `check` on the restored clean stack. STATE_FILE carries the ids between them.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { signIn } from "./client.mjs";

const { STATE_FILE } = process.env;
const phase = process.argv[2];
const { json, post, upload, ask } = await signIn();

if (phase === "seed") {
  const { vault } = await post("/api/v1/vaults", { name: "Rehearsal" }, 201);
  const kept = await upload(
    vault.id,
    "kept.txt",
    "The Supplier shall give ninety days written notice before ending this agreement.\n",
    "text/plain",
  );
  const doomed = await upload(
    vault.id,
    "doomed.txt",
    "This file is deleted after the backup and must stay deleted.\n",
    "text/plain",
  );
  assert.equal(kept.state, "ready");
  assert.equal(doomed.state, "ready");
  writeFileSync(STATE_FILE, JSON.stringify({ vault: vault.id, kept: kept.id, doomed: doomed.id }));
  console.log("ok: two files uploaded before the backup");
} else {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const files = async () =>
    (await json(`/api/v1/vaults/${state.vault}/tree`)).files.map((f) => f.id);
  if (phase === "delete") {
    await post(`/api/v1/vaults/${state.vault}/trash`, {
      document_ids: [state.doomed],
      folder_ids: [],
    });
    assert.deepEqual(await files(), [state.kept]);
    console.log("ok: one file deleted after the backup");
  } else if (phase === "check") {
    assert.deepEqual(await files(), [state.kept]);
    console.log("ok: the deleted file stayed deleted, and the other came back");
    const { stream } = await ask(state.vault, "How much notice must the Supplier give?");
    assert.match(stream, /"verified":"ok"/);
    console.log("ok: a restored file answers a question with a verified citation");
  } else {
    throw new Error("phase is seed, delete or check");
  }
}
