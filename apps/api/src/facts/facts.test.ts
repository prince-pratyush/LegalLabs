import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { factWorld, LETTER } from "../test-facts.js";

const pool = testPool();
afterAll(() => pool.end());

const QUOTE = "delivered the goods on 3 March 2021";

/** Ana's Space, with Ben in it, over a vault holding one letter. */
async function room() {
  const w = await factWorld(pool);
  const spaceId = await w.space();
  const vaultId = await w.vault(w.ana, "Data room");
  const resourceId = await w.share(spaceId, vaultId);
  const letter = await w.file(w.ana, vaultId, "letter.txt", LETTER);
  const base = `/apps/chronology/spaces/${spaceId}`;
  const body = (over: object = {}) => ({
    text: "The supplier delivered the goods.",
    event_date: "2021-03-03",
    date_precision: "day",
    citations: [{ document_version_id: letter.versionId, page_no: 1, quote: QUOTE }],
    ...over,
  });
  const add = async (over: object = {}) => {
    const res = await w.call(w.ben, "POST", `${base}/facts`, body(over));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.fact;
  };
  return { ...w, spaceId, vaultId, resourceId, letter, base, body, add };
}

describe("fact tables", () => {
  it("adds a fact whose quote is on the page, and keeps its words out of the audit log", async () => {
    const r = await room();
    const fact = await r.add();
    expect(fact).toMatchObject({
      status: "extracted",
      source: "manual",
      version_no: 1,
      event_date: "2021-03-03",
    });
    expect(fact.citations).toEqual([
      expect.objectContaining({
        document_id: r.letter.documentId,
        version_id: r.letter.versionId,
        document_name: "letter.txt",
        page_no: 1,
        quote: QUOTE,
        char_from: LETTER.indexOf(QUOTE),
        char_to: LETTER.indexOf(QUOTE) + QUOTE.length,
        verified: "ok",
      }),
    ]);
    const list = await r.call(r.ana, "GET", `${r.base}/facts`);
    expect(list.body.facts.map((f: { id: string }) => f.id)).toEqual([fact.id]);
    const events = (await auditTrail(pool, r.ana.workspaceId)).filter(
      (e) => e.action === "facts.created_manual",
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("supplier");
  });

  it("stores nothing when a quote isn't on the page", async () => {
    const r = await room();
    for (const citation of [
      { document_version_id: r.letter.versionId, page_no: 1, quote: "delivered nothing at all" },
      { document_version_id: r.letter.versionId, page_no: 2, quote: QUOTE },
    ]) {
      const res = await r.call(r.ben, "POST", `${r.base}/facts`, r.body({ citations: [citation] }));
      expect([res.status, res.body.code]).toEqual([422, "QUOTE_NOT_FOUND"]);
    }
    expect((await r.call(r.ben, "GET", `${r.base}/facts`)).body.facts).toEqual([]);
  });

  it("cites only files in vaults shared with the Space", async () => {
    const r = await room();
    const other = await r.vault(r.ben, "Ben's own");
    const mine = await r.file(r.ben, other, "mine.txt", LETTER);
    const res = await r.call(
      r.ben,
      "POST",
      `${r.base}/facts`,
      r.body({ citations: [{ document_version_id: mine.versionId, page_no: 1, quote: QUOTE }] }),
    );
    expect([res.status, res.body.code]).toEqual([404, "DOCUMENT_NOT_FOUND"]);
  });

  it("is not there for someone outside the Space", async () => {
    const r = await room();
    const fact = await r.add();
    const cal = await r.person("cal");
    for (const path of [
      "/facts",
      `/facts/${fact.id}`,
      `/facts/${fact.id}/versions`,
      "/facts/audit",
      "/entities",
      "/issues",
    ]) {
      expect((await r.call(cal, "GET", `${r.base}${path}`)).status).toBe(404);
    }
    expect((await r.call(cal, "POST", `${r.base}/facts`, r.body())).status).toBe(404);
  });

  it("takes a fact away from a member who can no longer open its document", async () => {
    const r = await room();
    const fact = await r.add();
    await r.call(r.ben, "PATCH", `${r.base}/facts/${fact.id}`, { text: "The goods arrived late." });
    // The vault leaves the Space: Ben loses the file, Ana still owns it.
    const removed = await r.call(r.ana, "DELETE", `/spaces/${r.spaceId}/resources/${r.resourceId}`);
    expect(removed.status).toBeLessThan(300);
    expect((await r.call(r.ben, "GET", `${r.base}/facts`)).body.facts).toEqual([]);
    for (const path of [`/facts/${fact.id}`, `/facts/${fact.id}/versions`]) {
      const res = await r.call(r.ben, "GET", `${r.base}${path}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("goods");
    }
    const trail = await r.call(r.ben, "GET", `${r.base}/facts/audit`);
    expect(JSON.stringify(trail.body)).not.toContain("goods");
    const change = await r.call(r.ben, "POST", `${r.base}/facts/${fact.id}/status`, {
      status: "confirmed",
    });
    expect(change.status).toBe(404);
    expect((await r.call(r.ana, "GET", `${r.base}/facts`)).body.facts).toHaveLength(1);
  });

  it("hides a fact from someone walled from the document's matter", async () => {
    const r = await room();
    const matterId = (
      await pool.query<{ id: string }>(
        `insert into core.matter (workspace_id, client_id, client_name, matter_number,
           matter_name, wall_mode)
         values ($1, 'c', 'Client', 'W-1', 'Walled', 'open') returning id`,
        [r.ana.workspaceId],
      )
    ).rows[0]?.id as string;
    const walled = await r.vault(r.ana, "Walled", matterId);
    await r.share(r.spaceId, walled).catch(() => {
      // A Space without the matter may refuse the share; the resource is then written directly.
      return pool.query(
        `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id,
           access, granted_by) values ($1, $2, 'vault', $3, 'view', $4)`,
        [r.ana.workspaceId, r.spaceId, walled, r.ana.userId],
      );
    });
    const secret = await r.file(r.ana, walled, "secret.txt", LETTER);
    const fact = await r.add({
      citations: [{ document_version_id: secret.versionId, page_no: 1, quote: QUOTE }],
    });
    await pool.query("update core.matter set wall_mode = 'allow_list' where id = $1", [matterId]);
    expect((await r.call(r.ben, "GET", `${r.base}/facts`)).body.facts).toEqual([]);
    expect((await r.call(r.ben, "GET", `${r.base}/facts/${fact.id}`)).status).toBe(404);
  });

  it("keeps every version, with before and after in the table's own trail", async () => {
    const r = await room();
    const fact = await r.add();
    const edited = await r.call(r.ben, "PATCH", `${r.base}/facts/${fact.id}`, {
      text: "The supplier delivered late.",
    });
    expect(edited.body.fact).toMatchObject({ version_no: 2, text: "The supplier delivered late." });
    const same = await r.call(r.ben, "PATCH", `${r.base}/facts/${fact.id}`, {
      text: "The supplier delivered late.",
    });
    expect(same.body.fact.version_no).toBe(2);
    const versions = await r.call(r.ben, "GET", `${r.base}/facts/${fact.id}/versions`);
    expect(versions.body.versions.map((v: { no: number; text: string }) => [v.no, v.text])).toEqual(
      [
        [2, "The supplier delivered late."],
        [1, "The supplier delivered the goods."],
      ],
    );
    const trail = await r.call(r.ben, "GET", `${r.base}/facts/audit`);
    const entry = trail.body.entries.find((e: { action: string }) => e.action === "edited");
    expect(entry.details).toMatchObject({
      before: { text: "The supplier delivered the goods." },
      after: { text: "The supplier delivered late." },
    });
    expect(JSON.stringify(await auditTrail(pool, r.ana.workspaceId))).not.toContain("delivered");
  });

  it("marks a fact confirmed, disputed or rejected", async () => {
    const r = await room();
    const fact = await r.add();
    for (const status of ["confirmed", "disputed", "rejected", "extracted"]) {
      const res = await r.call(r.ben, "POST", `${r.base}/facts/${fact.id}/status`, { status });
      expect(res.body.fact.status).toBe(status);
    }
    const bad = await r.call(r.ben, "POST", `${r.base}/facts/${fact.id}/status`, { status: "x" });
    expect(bad.status).toBe(400);
  });

  it("links people and issues, and filters by them, by date, file and status", async () => {
    const r = await room();
    const entity = (
      await r.call(r.ben, "POST", `${r.base}/entities`, {
        kind: "person",
        canonical_name: "Zed Brown",
        aliases: ["Z. Brown"],
      })
    ).body.entity;
    const issue = (await r.call(r.ben, "POST", `${r.base}/issues`, { name: "Delivery delays" }))
      .body.issue;
    const march = await r.add({ entity_ids: [entity.id], issue_ids: [issue.id] });
    const may = await r.add({
      text: "A reminder was sent.",
      event_date: "2021-05-01",
      date_precision: "month",
    });
    const undated = await r.add({
      text: "The terms applied.",
      event_date: null,
      date_precision: "unknown",
    });
    const ids = async (query: string) =>
      (await r.call(r.ben, "GET", `${r.base}/facts${query}`)).body.facts.map(
        (f: { id: string }) => f.id,
      );
    expect(await ids("")).toEqual([march.id, may.id, undated.id]);
    expect(await ids(`?filter[entity_id]=${entity.id}`)).toEqual([march.id]);
    expect(await ids(`?filter[issue_id]=${issue.id}`)).toEqual([march.id]);
    // A month-precise date covers its whole month.
    expect(await ids("?filter[from]=2021-05-20")).toEqual([may.id]);
    expect(await ids("?filter[to]=2021-03-31")).toEqual([march.id]);
    expect(await ids(`?filter[document_id]=${r.letter.documentId}`)).toHaveLength(3);
    await r.call(r.ben, "POST", `${r.base}/facts/${may.id}/status`, { status: "rejected" });
    expect(await ids("?filter[status]=rejected")).toEqual([may.id]);
    const unknown = await r.call(r.ben, "PATCH", `${r.base}/facts/${march.id}`, {
      entity_ids: ["0198a0c0-0000-7000-8000-000000000001"],
    });
    expect([unknown.status, unknown.body.code]).toEqual([422, "UNKNOWN_ENTITY"]);
    const renamed = await r.call(r.ben, "PATCH", `${r.base}/entities/${entity.id}`, {
      canonical_name: "Zed A. Brown",
    });
    expect(renamed.body.entity.canonical_name).toBe("Zed A. Brown");
    const unlinked = await r.call(r.ben, "PATCH", `${r.base}/facts/${march.id}`, {
      entity_ids: [],
    });
    expect(unlinked.body.fact).toMatchObject({ entity_ids: [], version_no: 2 });
  });

  it("lists the files a fact can come from, only while the caller can open them", async () => {
    const r = await room();
    const listed = await r.call(r.ben, "GET", `${r.base}/files`);
    expect(listed.body).toEqual({
      files: [
        {
          document_id: r.letter.documentId,
          version_id: r.letter.versionId,
          name: "letter.txt",
          vault_id: r.vaultId,
          vault_name: "Data room",
          page_count: 1,
          ready: true,
        },
      ],
      truncated: false,
    });
    await r.call(r.ana, "DELETE", `/spaces/${r.spaceId}/resources/${r.resourceId}`);
    expect((await r.call(r.ben, "GET", `${r.base}/files`)).body.files).toEqual([]);
  });

  it("keeps a name read from a file tied to it through a rename that changes nothing", async () => {
    const r = await room();
    const fact = await r.add();
    // As extraction leaves them: an entry and an issue seen only through the fact.
    const seed = async (table: "entity" | "issue", columns: string, values: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into apps.${table} (workspace_id, space_id, origin, created_by, ${columns})
         values ($1, $2, 'extracted', $3, ${values}) returning id`,
        [r.ana.workspaceId, r.spaceId, r.ben.userId],
      );
      const id = rows[0]?.id as string;
      await pool.query(
        `insert into apps.fact_${table} (workspace_id, space_id, fact_id, ${table}_id, via)
         values ($1, $2, $3, $4, 'extracted')`,
        [r.ana.workspaceId, r.spaceId, fact.id, id],
      );
      return id;
    };
    const entity = await seed("entity", "kind, canonical_name", "'person', 'Zed Brown'");
    const issue = await seed("issue", "name", "'Late delivery'");
    const origin = async (table: "entity" | "issue", id: string) =>
      (await pool.query(`select origin from apps.${table} where id = $1`, [id])).rows[0]?.origin;
    const patch = (path: string, body: object) => r.call(r.ben, "PATCH", `${r.base}/${path}`, body);

    for (const name of ["ZED BROWN", "zed   brown", "Zed\u00a0Brown", "Zed Brown."]) {
      const res = await patch(`entities/${entity}`, { canonical_name: name });
      expect([name, res.status]).toEqual([name, 200]);
      expect([name, await origin("entity", entity)]).toEqual([name, "extracted"]);
    }
    expect((await patch(`issues/${issue}`, { name: "late  Delivery" })).status).toBe(200);
    expect(await origin("issue", issue)).toBe("extracted");

    await patch(`entities/${entity}`, { canonical_name: "Zedekiah Brown" });
    await patch(`issues/${issue}`, { name: "Delay in delivery" });
    expect(await origin("entity", entity)).toBe("manual");
    expect(await origin("issue", issue)).toBe("manual");
  });

  it("pages by date with a cursor", async () => {
    const r = await room();
    const one = await r.add({ event_date: null, date_precision: "unknown" });
    // A page's worth more, written straight to the tables to keep the test quick.
    await pool.query(
      `with made as (
         insert into apps.fact (workspace_id, space_id, created_by, source, source_documents,
           text, date_precision)
         select workspace_id, space_id, created_by, source, source_documents, text, 'unknown'
           from apps.fact, generate_series(1, 100) where id = $1
         returning id, workspace_id, text, created_by),
       versions as (
         insert into apps.fact_version (workspace_id, fact_id, no, text, date_precision, edited_by)
         select workspace_id, id, 1, text, 'unknown', created_by from made)
       insert into apps.fact_citation (workspace_id, fact_id, document_id, document_version_id,
         page_no, char_from, char_to, quote)
       select c.workspace_id, made.id, c.document_id, c.document_version_id, c.page_no,
              c.char_from, c.char_to, c.quote
         from made, apps.fact_citation c where c.fact_id = $1`,
      [one.id],
    );
    const first = await r.call(r.ben, "GET", `${r.base}/facts`);
    expect(first.body.facts).toHaveLength(100);
    const rest = await r.call(
      r.ben,
      "GET",
      `${r.base}/facts?cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(rest.body.facts).toHaveLength(1);
    expect(rest.body.next_cursor).toBeNull();
    expect((await r.call(r.ben, "GET", `${r.base}/facts?cursor=x`)).status).toBe(400);
  });
});
