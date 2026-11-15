import { randomUUID } from "node:crypto";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { createVaultPort } from "./port.js";
import { createVaults } from "./vaults.js";

const pool = testPool();
afterAll(() => pool.end());
const client = { ip: null, userAgent: null };

describe("the vault port threads uses", () => {
  it("lists the caller's vaults and the files in them they may read", async () => {
    const m = await seedMember(pool);
    const caller = { userId: m.userId, workspaceId: m.workspaceId };
    const store = createMemoryStore();
    const documents = testDocuments(pool, { store });
    const vaults = createVaults(pool, { documents, store });
    const created = await vaults.create({ ...caller, sessionId: "s" }, { name: "Atlas" }, client);
    if (!created.ok) throw new Error("no vault");
    const vault = created.value.id;
    const bytes = new TextEncoder().encode("The supplier accepts liability.");
    const first = await vaults.upload(
      { ...caller, sessionId: "s" },
      vault,
      { name: "a.txt", bytes, folderId: null },
      client,
    );
    await vaults.upload(
      { ...caller, sessionId: "s" },
      vault,
      { name: "b.txt", bytes, folderId: null },
      client,
    );
    if (!first.ok) throw new Error("no upload");

    const port = createVaultPort(pool);
    expect(await port.list(caller)).toEqual([{ id: vault, name: "Atlas", file_count: 2 }]);
    expect(await port.documentIds(caller, [vault], 10)).toHaveLength(2);
    expect(await port.documentIds(caller, [vault], 1)).toHaveLength(1);

    await vaults.trash(
      { ...caller, sessionId: "s" },
      vault,
      { documentIds: [first.document.id], folderIds: [] },
      client,
    );
    expect(await port.documentIds(caller, [vault], 10)).toHaveLength(1);

    const stranger = await seedMember(pool);
    const other = { userId: stranger.userId, workspaceId: stranger.workspaceId };
    expect(await port.list(other)).toEqual([]);
    expect(await port.documentIds(other, [vault, randomUUID()], 10)).toEqual([]);
  });
});
