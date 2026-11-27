import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { factWorld } from "../test-facts.js";

const pool = testPool();
afterAll(() => pool.end());

const GOODS = "The supplier delivered the goods on 3 March 2021.";
const RECEIPT = "Zed Brown signed the receipt on 9 July 2021.";

async function room() {
  const w = await factWorld(pool);
  const spaceId = await w.space("Acme dispute");
  const vaultId = await w.vault(w.ana, "Data room");
  const resourceId = await w.share(spaceId, vaultId);
  const goods = await w.file(w.ana, vaultId, "goods.txt", GOODS);
  const receipt = await w.file(w.ana, vaultId, "receipt.txt", RECEIPT);
  const base = `/apps/chronology/spaces/${spaceId}`;
  const issue = (await w.call(w.ben, "POST", `${base}/issues`, { name: "Delivery delays" })).body
    .issue.id as string;
  const add = async (
    text: string,
    quote: string,
    file: { versionId: string },
    date: string,
    issues: string[] = [],
  ) =>
    (
      await w.call(w.ben, "POST", `${base}/facts`, {
        text,
        event_date: date,
        date_precision: "day",
        issue_ids: issues,
        citations: [{ document_version_id: file.versionId, page_no: 1, quote }],
      })
    ).body.fact.id as string;
  const late = await add("=HYPERLINK(late)", RECEIPT, receipt, "2021-07-09");
  const delivered = await add("Goods delivered.", GOODS, goods, "2021-03-03", [issue]);
  const disputed = await add("A disputed event.", GOODS, goods, "2021-04-01", [issue]);
  const rejected = await add("A rejected event.", GOODS, goods, "2021-04-02", [issue]);
  const mark = (id: string, status: string) =>
    w.call(w.ben, "POST", `${base}/facts/${id}/status`, { status });
  await mark(disputed, "disputed");
  await mark(rejected, "rejected");
  const generate = (body: object = {}, who = w.ben) =>
    w.call(who, "POST", `${base}/facts/generate`, body);
  const draftOf = async (threadId: string, who = w.ben) =>
    w.call(who, "GET", `/threads/${threadId}/drafts`);
  return {
    ...w,
    spaceId,
    vaultId,
    resourceId,
    goods,
    receipt,
    base,
    issue,
    late,
    delivered,
    generate,
    draftOf,
  };
}

const textOf = (bytes: Uint8Array, part: string) =>
  new TextDecoder().decode(unzipSync(bytes)[part]);

describe("chronologies", () => {
  it("drafts the facts in date order in a thread, each with its quote", async () => {
    const r = await room();
    const made = await r.generate();
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ facts: 2, left_out: 0 });
    const drafts = await r.draftOf(made.body.thread_id);
    const body: string = drafts.body.items[0].latest.body;
    expect(body.indexOf("Goods delivered.")).toBeLessThan(body.indexOf("HYPERLINK"));
    expect(body).toContain(`goods.txt, p. 1: "${GOODS}"`);
    expect(body).not.toContain("disputed event");
    expect(body).not.toContain("rejected event");
    const events = await auditTrail(pool, r.ana.workspaceId);
    expect(events.find((e) => e.action === "facts.generated")?.details).toMatchObject({
      facts: 2,
      left_out: 0,
    });
    expect(JSON.stringify(events)).not.toContain("delivered");
  });

  it("filters by issue and dates, and takes disputed facts only when asked", async () => {
    const r = await room();
    const made = await r.generate({
      style: "narrative",
      filter: {
        issue_ids: [r.issue],
        from: "2021-01-01",
        to: "2021-06-30",
        include_disputed: true,
      },
    });
    expect(made.body.facts).toBe(2);
    const body: string = (await r.draftOf(made.body.thread_id)).body.items[0].latest.body;
    expect(body).toContain("## 3 Mar 2021");
    expect(body).toContain("A disputed event. (disputed)");
    expect(body).not.toContain("HYPERLINK");
    expect(body).not.toContain("rejected event");
  });

  it("closes the thread to anyone who can no longer open every source", async () => {
    const r = await room();
    const threadId = (await r.generate()).body.thread_id;
    expect((await r.call(r.ben, "GET", `/threads/${threadId}`)).status).toBe(200);
    const history = async () => JSON.stringify((await r.call(r.ben, "GET", "/history")).body);
    await r.call(r.ana, "DELETE", `/spaces/${r.spaceId}/resources/${r.resourceId}`);
    expect((await r.call(r.ben, "GET", `/threads/${threadId}`)).status).toBe(404);
    expect((await r.draftOf(threadId)).status).toBe(404);
    expect(await history()).not.toContain(threadId);
    expect((await r.generate()).body.code).toBe("NOTHING_TO_INCLUDE");
  });

  it("keeps a shared chronology from someone who can't open its sources", async () => {
    const r = await room();
    const threadId = (await r.generate()).body.thread_id;
    const cal = await r.person("cal");
    const shared = await r.call(r.ben, "POST", `/threads/${threadId}/shares`, {
      user_ids: [cal.userId],
    });
    expect(shared.status).toBeLessThan(300);
    const read = await r.call(cal, "GET", `/threads/${threadId}`);
    expect(read.status).toBe(404);
    expect(JSON.stringify((await r.draftOf(threadId, cal)).body)).not.toContain("delivered");
    // The share itself stands: once Cal can open the sources, the thread opens.
    await pool.query(
      `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
         principal_id, level, granted_by)
       values ($1, 'vault', $2, 'user', $3, 'view', $4)`,
      [r.ana.workspaceId, r.vaultId, cal.userId, r.ana.userId],
    );
    expect((await r.call(cal, "GET", `/threads/${threadId}`)).status).toBe(200);
  });

  it("exports Word and Excel with citations, and never a formula", async () => {
    const r = await room();
    const get = (query: string) => r.call(r.ben, "GET", `${r.base}/facts/export?${query}`);
    const word = await get("format=docx&view=table");
    expect(word.status).toBe(200);
    expect(word.disposition).toBe('attachment; filename="chronology.docx"');
    const document = textOf(word.bytes, "word/document.xml");
    expect(document).toContain("<w:tbl>");
    expect(document).toContain("Goods delivered.");
    expect(document).toContain("goods.txt, p. 1");
    expect(document).not.toContain("rejected event");
    const narrative = await get("format=docx&view=narrative");
    expect(textOf(narrative.bytes, "word/footnotes.xml")).toContain("receipt.txt, p. 1");
    const excel = await get("format=xlsx");
    const sheet = textOf(excel.bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("'=HYPERLINK(late)");
    const filtered = await get(`format=xlsx&filter[issue_id]=${r.issue}`);
    expect(textOf(filtered.bytes, "xl/worksheets/sheet1.xml")).not.toContain("HYPERLINK");
    expect((await get("format=pdf")).status).toBe(400);
    const events = await auditTrail(pool, r.ana.workspaceId);
    expect(events.filter((e) => e.action === "facts.exported")).toHaveLength(4);
  });

  it("leaves out a fact whose quote is no longer on its page, and says so", async () => {
    const r = await room();
    await pool.query("update content.page set text = 'Replaced.' where version_id = $1", [
      r.receipt.versionId,
    ]);
    const made = await r.generate();
    expect(made.body).toMatchObject({ facts: 1, left_out: 1 });
    const body: string = (await r.draftOf(made.body.thread_id)).body.items[0].latest.body;
    expect(body).not.toContain("HYPERLINK");
    expect(body).toContain("1 fact(s) were left out");
  });

  it("follows the vault's copy and download controls", async () => {
    const r = await room();
    await pool.query(
      `update content.vault set content_controls = content_controls || '{"allow_download": false}'
        where id = $1`,
      [r.vaultId],
    );
    expect((await r.generate()).body.code).toBe("EXPORT_DISABLED");
    const exported = await r.call(r.ben, "GET", `${r.base}/facts/export?format=xlsx`);
    expect(exported.status).toBe(403);
    // The vault's owner is not bound by them.
    expect((await r.generate({}, r.ana)).status).toBe(201);
  });

  it("applies the vault's controls to whoever downloads the draft, as they stand then", async () => {
    const r = await room();
    const control = (value: boolean, key: "allow_download" | "allow_duplicate") =>
      pool.query(
        `update content.vault
            set content_controls = content_controls || jsonb_build_object($2::text, $3::boolean)
          where id = $1`,
        [r.vaultId, key, value],
      );
    const exports = ["", "?format=pdf", "?tracked_from=1"];
    const download = async (who: typeof r.ben, draftId: string) => {
      const out: number[] = [];
      for (const query of exports) {
        out.push((await r.call(who, "GET", `/drafts/${draftId}/export${query}`)).status);
      }
      return out;
    };

    // Made by the vault's owner and shared view-only.
    await control(false, "allow_download");
    const owners = (await r.generate({}, r.ana)).body;
    await r.call(r.ana, "POST", `/threads/${owners.thread_id}/shares`, {
      user_ids: [r.ben.userId],
    });
    expect((await r.draftOf(owners.thread_id)).status).toBe(200);
    expect(await download(r.ben, owners.draft_id)).toEqual([403, 403, 403]);
    expect(await download(r.ana, owners.draft_id)).toEqual([200, 200, 200]);

    // Made while copies were allowed, then tightened.
    await control(true, "allow_download");
    const mine = (await r.generate()).body;
    expect(await download(r.ben, mine.draft_id)).toEqual([200, 200, 200]);
    await control(false, "allow_duplicate");
    const refused = await r.call(r.ben, "GET", `/drafts/${mine.draft_id}/export`);
    expect([refused.status, refused.body.code]).toEqual([403, "EXPORT_DISABLED"]);
    expect(await download(r.ben, mine.draft_id)).toEqual([403, 403, 403]);
    const events = await auditTrail(pool, r.ana.workspaceId);
    expect(events.filter((e) => e.action === "draft.exported")).toHaveLength(6);
  });

  it("builds nothing for someone outside the Space", async () => {
    const r = await room();
    const cal = await r.person("cal");
    expect((await r.generate({}, cal)).status).toBe(404);
    expect((await r.call(cal, "GET", `${r.base}/facts/export?format=docx`)).status).toBe(404);
  });
});
