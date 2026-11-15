import { performance } from "node:perf_hooks";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "../auth/auth.js";
import { createDocuments } from "../documents/documents.js";
import { seedMember, testPool } from "../test-db.js";
import { createVaults } from "./vaults.js";

// Run with VAULT_BENCH=1: seeds 10,000 synthetic files, so it is too slow for every PR.
const FILES = Number(process.env.VAULT_BENCH_FILES ?? 10_000);
const FOLDERS = 50;
const PAGES = 3;
const RUNS = 7;

const pool = testPool();
afterAll(() => pool.end());

async function time(label: string, work: () => Promise<unknown>) {
  await work();
  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await work();
    runs.push(performance.now() - start);
  }
  runs.sort((a, b) => a - b);
  return { label, median: runs[Math.floor(RUNS / 2)] ?? 0, max: runs.at(-1) ?? 0 };
}

describe.skipIf(!process.env.VAULT_BENCH)("a 10,000-file vault", () => {
  it("stays fast to list, browse and search, and keeps walled files out", async () => {
    const m = await seedMember(pool);
    const ana: Principal = { sessionId: "bench", userId: m.userId, workspaceId: m.workspaceId };
    const store = createMemoryStore();
    const documents = createDocuments(pool, { store });
    const vaults = createVaults(pool, { documents, store });
    const created = await vaults.create(ana, { name: "Data room" }, { ip: null, userAgent: null });
    if (!created.ok) throw new Error("vault not created");
    const vault = created.value.id;

    // A colleague with view access, walled off from one matter that 5% of the files carry.
    const ben =
      (
        await pool.query<{ id: string }>(
          `insert into core."user" (workspace_id, email, role_id, status)
         select $1, 'ben@bench.test', role_id, 'active' from core."user" where id = $2
         returning id`,
          [m.workspaceId, m.userId],
        )
      ).rows[0]?.id ?? "";
    const matter =
      (
        await pool.query<{ id: string }>(
          `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
         values ($1, 'C', 'Client', 'M-1', 'Walled', 'open') returning id`,
          [m.workspaceId],
        )
      ).rows[0]?.id ?? "";
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [m.workspaceId, matter, ben],
    );

    const seedStart = performance.now();
    await pool.query(
      `insert into content.folder (workspace_id, vault_id, name, created_by)
       select $1, $2, 'Folder ' || lpad(i::text, 3, '0'), $3 from generate_series(1, $4) i`,
      [m.workspaceId, vault, m.userId, FOLDERS],
    );
    await pool.query(
      `with folders as (
         select id, row_number() over (order by name) - 1 n from content.folder where vault_id = $2
       ), docs as (
         insert into content.document
           (workspace_id, owner_id, matter_id, name, mime, size, vault_id, folder_id)
         select $1, $3, case when i % 20 = 0 then $5::uuid end,
                'Agreement ' || lpad(i::text, 5, '0') || '.pdf', 'application/pdf', 40000 + i, $2,
                (select id from folders where n = i % $6)
           from generate_series(1, $4) i
         returning id, name
       ), versions as (
         insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
         select $1, id, sha256(convert_to(name, 'UTF8')), $7, $3 from docs
         returning id
       ), jobs as (
         insert into content.ingest_job (workspace_id, version_id, status)
         select $1, id, 'indexed' from versions
       )
       select count(*) from versions`,
      [m.workspaceId, vault, m.userId, FILES, matter, FOLDERS, PAGES],
    );
    // Varied clause text, so keyword search has real work to do.
    await pool.query(
      `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
       select v.workspace_id, v.id, p, 612, 792,
              format('Clause %s.%s. The %s shall %s the %s within %s days of %s. Governing law: %s.',
                     d.name, p,
                     (array['supplier','customer','licensee','lessor','borrower'])[1 + (hashtext(d.name || p) & 4)],
                     (array['indemnify','notify','pay','deliver','terminate'])[1 + (hashtext(p || d.name) & 4)],
                     (array['losses','invoice','goods','premises','facility'])[1 + ((hashtext(d.name) >> 3) & 4)],
                     10 + (hashtext(d.name) & 63),
                     (array['completion','notice','demand','closing','renewal'])[1 + ((hashtext(d.name) >> 5) & 4)],
                     (array['England','Delaware','New South Wales','Singapore','Ontario'])[1 + ((hashtext(d.name) >> 7) & 4)]),
              '{"blocks":[]}'
         from content.document_version v
         join content.document d on d.id = v.document_id
         cross join generate_series(1, $2) p
        where d.vault_id = $1`,
      [vault, PAGES],
    );
    await pool.query(
      `insert into content.chunk (workspace_id, version_id, page_no, ordinal, char_from, char_to, text)
       select p.workspace_id, p.version_id, p.page_no, p.page_no - 1, 0, char_length(p.text), p.text
         from content.page p join content.document_version v on v.id = p.version_id
         join content.document d on d.id = v.document_id where d.vault_id = $1`,
      [vault],
    );
    await pool.query(
      "analyze content.document, content.document_version, content.chunk, content.folder",
    );
    const seedMs = performance.now() - seedStart;

    const folder = (await vaults.tree(ana, vault, {}))?.folders[10]?.id ?? null;
    const query = "supplier indemnify losses";
    const benP: Principal = { sessionId: "bench", userId: ben, workspaceId: m.workspaceId };
    await vaults.setShares(
      ana,
      vault,
      {
        grants: [{ principal_type: "user", principal_id: ben, level: "view" }],
        workspaceView: false,
      },
      { ip: null, userAgent: null },
    );

    const results = [
      await time("list vaults", () => vaults.list(ana)),
      await time("open vault (stats)", () => vaults.get(ana, vault)),
      await time("tree: top level", () => vaults.tree(ana, vault, {})),
      await time("tree: folder page (200)", () => vaults.tree(ana, vault, { folderId: folder })),
      await time("tree: name search", () => vaults.tree(ana, vault, { q: "agreement 0999" })),
      await time("search: vault scope", () =>
        documents.search(ana, query, { scope: { vault_ids: [vault] } }),
      ),
      await time("search: folder scope", () =>
        documents.search(ana, query, { scope: { folder_ids: folder ? [folder] : [] } }),
      ),
      await time("search: any words, vault", () =>
        documents.search(ana, query, { scope: { vault_ids: [vault] }, match: "any", limit: 50 }),
      ),
      await time("search: walled viewer", () =>
        documents.search(benP, query, { scope: { vault_ids: [vault] }, match: "any", limit: 50 }),
      ),
    ];

    // Walls hold at this size: none of the walled files' text reaches the viewer.
    const walled = new Set(
      (
        await pool.query<{ id: string }>("select id from content.document where matter_id = $1", [
          matter,
        ])
      ).rows.map((row) => row.id),
    );
    expect(walled.size).toBe(FILES / 20);
    const seen = await documents.search(benP, "Clause Agreement", {
      scope: { vault_ids: [vault] },
      match: "any",
      limit: 50,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((p) => walled.has(p.documentId))).toEqual([]);
    const oneWalled = [...walled][0] ?? "";
    const anaSees = await documents.search(ana, "clause", { scope: { document_ids: [oneWalled] } });
    expect(anaSees.length).toBeGreaterThan(0);
    expect(
      await documents.search(benP, "clause", { scope: { document_ids: [oneWalled] } }),
    ).toEqual([]);
    const benTree = await vaults.get(benP, vault);
    expect(benTree?.stats.hidden).toBe(FILES / 20);

    const table = results
      .map((r) => `| ${r.label} | ${r.median.toFixed(1)} | ${r.max.toFixed(1)} |`)
      .join("\n");
    console.log(
      `\n${FILES} files, ${FOLDERS} folders, ${FILES * PAGES} chunks; seeded in ${(seedMs / 1000).toFixed(1)} s\n` +
        `| operation | median ms | max ms |\n|---|---|---|\n${table}\n`,
    );
    // Recorded, not asserted: timings depend on the machine, the walls must not.
    expect(results).toHaveLength(9);
  }, 600_000);
});
