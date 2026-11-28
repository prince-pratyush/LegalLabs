import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { asApp } from "../db.js";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { countingProviders, fileInMatter, newMatter } from "../test-model-policy.js";
import { type Material, modelsFor } from "./model-policy.js";

const pool = testPool();
afterAll(() => pool.end());

const gateway = createGateway({
  providers: countingProviders(() => "").providers,
  recordUsage: async () => {},
});

async function setup() {
  const m = await seedMember(pool);
  const matterId = await newMatter(pool, m);
  const documents = testDocuments(pool);
  const uploaded = await documents.upload(
    { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId },
    { name: "a.txt", bytes: new TextEncoder().encode("Rent is due."), matterId: null },
    { ip: null, userAgent: null },
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  await fileInMatter(pool, uploaded.document.versionId, matterId);
  const allows = (material: Material) =>
    asApp(pool, m, async (db) => (await modelsFor(db, gateway, material)).allows("draft_edit"));
  const wall = () =>
    pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [m.workspaceId, matterId, m.userId],
    );
  return { ...uploaded.document, allows, wall };
}

describe("a matter's model policy when the caller can't see what a call is about", () => {
  it("allows what is open to the caller, and what names nothing", async () => {
    const s = await setup();
    expect(await s.allows({ documents: [s.id], versions: [s.versionId] })).toBe(true);
    expect(await s.allows({ matters: [null], threads: [undefined] })).toBe(true);
  });

  it("refuses an id that resolves to nothing", async () => {
    const s = await setup();
    for (const kind of ["matters", "documents", "versions", "threads", "spaces", "tables"]) {
      expect([kind, await s.allows({ [kind]: [randomUUID()] })]).toEqual([kind, false]);
    }
  });

  it("refuses a document or version behind a wall", async () => {
    const s = await setup();
    await s.wall();
    expect(await s.allows({ documents: [s.id] })).toBe(false);
    expect(await s.allows({ versions: [s.versionId] })).toBe(false);
  });
});
