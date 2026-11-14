import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIMENSIONS, type Embedder, EmbedUnavailable } from "@legallabs/embed";
import { type AuthorityRecord, createFileLoader, type SourceId, sync } from "@legallabs/knowledge";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth, type Principal } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { noVaults } from "../threads/ports.js";
import { createKnowledge } from "./knowledge.js";
import { knowledgePort } from "./port.js";

const pool = testPool();
afterAll(() => pool.end());

// Public law is shared by every workspace, so each run uses volumes no other run will.
const VOL = randomInt(1000, 9000);
const cite = (n: number) => `${VOL + n} U.S. 1`;
const tag = `t${VOL}`;

const asPrincipal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

// Synthetic records: made-up parties and text, shaped as each loader produces them.
const opinion = (n: number, more: Partial<AuthorityRecord> = {}): AuthorityRecord => ({
  ref: `us_caselaw:cap:${tag}${n}`,
  title: `Doe ${tag} v. Roe ${n}`,
  court: n % 2 === 0 ? "Supreme Court of the United States" : "Court of Appeals",
  jurisdiction: "United States",
  docType: "opinion",
  decidedOn: `20${String(10 + n).padStart(2, "0")}-01-15`,
  url: `https://static.case.law/us/${VOL + n}/cases/0001-01.json`,
  citations: [{ text: cite(n), kind: "reporter" }],
  firstPage: 1,
  lastPage: 30,
  sections: [],
  meta: { cap_id: n },
  chunks: [
    {
      sectionPath: "Syllabus",
      text: `Syllabus ${tag}. The question is whether widgets ${n} count.`,
    },
    {
      sectionPath: "Opinion (majority)",
      text: `A complaint must state a plausible claim ${tag}${n}; bare conclusions do not suffice.`,
    },
  ],
  ...more,
});

const regulation: AuthorityRecord = {
  ref: `eurlex:celex:3${VOL}R0001`,
  title: `Regulation (EU) ${VOL}/1 on synthetic data ${tag}`,
  jurisdiction: "EU",
  docType: "regulation",
  decidedOn: "2016-04-27",
  citations: [
    { text: `CELEX:3${VOL}R0001`, kind: "celex" },
    { text: `Regulation (EU) ${VOL}/1`, kind: "act" },
    { text: `SDR${tag}`, kind: "alias" },
  ],
  sections: ["Article 1", "Article 6"],
  meta: { celex: `3${VOL}R0001` },
  chunks: [
    { sectionPath: "Article 1", text: `This Regulation ${tag} lays down rules on synthetic data.` },
    {
      sectionPath: "Article 6",
      text: `Processing ${tag} shall be lawful only if consent is given.`,
    },
  ],
};

const judgment: AuthorityRecord = {
  ref: `eurlex:celex:6${VOL}CJ0001`,
  title: `Example ${tag} v Agency`,
  court: "Court of Justice",
  jurisdiction: "EU",
  docType: "judgment",
  decidedOn: "2014-05-13",
  citations: [
    { text: `ECLI:EU:C:${VOL}:317`, kind: "ecli" },
    { text: `CELEX:6${VOL}CJ0001`, kind: "celex" },
  ],
  sections: [],
  meta: {},
  chunks: [{ sectionPath: "Preamble", text: `Search engine operators ${tag} process data.` }],
};

const filing: AuthorityRecord = {
  ref: `edgar:accession:00000${VOL}-24-000001`,
  title: `Example Widgets ${tag} 10-K (2024-02-01)`,
  jurisdiction: "US",
  docType: "10-K",
  decidedOn: "2024-02-01",
  citations: [{ text: `00000${VOL}-24-000001`, kind: "accession" }],
  sections: ["Item 1A"],
  meta: { cik: `${VOL}` },
  chunks: [{ sectionPath: "Item 1A", text: `Risk factors ${tag}: supply chain disruption.` }],
};

const knowledge = createKnowledge(pool);
let member: Seeded;

beforeAll(async () => {
  member = await seedMember(pool);
  const writer = knowledge.writer();
  for (const record of [opinion(1), opinion(2), opinion(3), regulation, judgment, filing]) {
    await writer.upsert(record);
  }
  // Two authorities that share one citation, as a bad merge or a parallel cite could.
  await writer.upsert(opinion(4, { citations: [{ text: cite(9), kind: "reporter" }] }));
  await writer.upsert(opinion(5, { citations: [{ text: cite(9), kind: "parallel" }] }));
});

describe("citation index", () => {
  const resolve = (citation: string, more: { pin?: string; quote?: string } = {}) =>
    knowledge.resolve(asPrincipal(member), { citation, ...more });

  it("resolves a reporter citation however it is written", async () => {
    for (const written of [cite(1), `${VOL + 1} U. S. 1 (2011)`, `${VOL + 1} us 1`]) {
      expect(await resolve(written)).toMatchObject({
        status: "ok",
        authorityRef: `us_caselaw:cap:${tag}1`,
        href: `/knowledge/authorities/${encodeURIComponent(`us_caselaw:cap:${tag}1`)}`,
      });
    }
  });

  it("never links a citation that is not indexed", async () => {
    const result = await resolve(`${VOL + 500} U.S. 1`);
    expect(result).toEqual({ status: "unresolved", reason: "authority_not_found" });
  });

  it("never links an ambiguous citation, and lists the candidates", async () => {
    const result = await resolve(cite(9));
    expect(result).toMatchObject({ status: "unresolved", reason: "ambiguous_authority" });
    expect(result).not.toHaveProperty("href");
    expect(result?.candidates?.map((c) => c.authorityRef)).toEqual([
      `us_caselaw:cap:${tag}4`,
      `us_caselaw:cap:${tag}5`,
    ]);
  });

  it("locates a quote and flags one the authority lacks", async () => {
    const found = await resolve(cite(2), { quote: `a plausible claim ${tag}2` });
    expect(found).toMatchObject({ status: "ok", located: { chunkId: expect.any(String) } });
    const missing = await resolve(cite(2), { quote: "a sentence this opinion never says at all" });
    expect(missing).toMatchObject({ status: "mismatch", reason: "quote_not_found" });
  });

  it("checks a page pin against the reported pages", async () => {
    expect(await resolve(cite(1), { pin: "12" })).toMatchObject({ status: "ok" });
    expect(await resolve(cite(1), { pin: "99" })).toMatchObject({
      status: "mismatch",
      reason: "pin_not_found",
    });
  });

  it("resolves an EU act by act form, CELEX and alias to one authority", async () => {
    const refs = new Set<string | undefined>();
    const forms = [
      `Regulation (EU) ${VOL}/1`,
      `Regulation (EU) No ${VOL}/1`,
      `CELEX:3${VOL}R0001`,
      `SDR${tag}`,
    ];
    for (const written of forms) {
      const result = await resolve(written);
      expect(result?.status).toBe("ok");
      refs.add(result?.authorityRef);
    }
    expect([...refs]).toEqual([regulation.ref]);
    expect(await resolve(`Regulation (EU) ${VOL}/1`, { pin: "Article 6" })).toMatchObject({
      status: "ok",
    });
  });

  it("resolves an ECLI and an accession number", async () => {
    expect(await resolve(`ECLI:EU:C:${VOL}:317`)).toMatchObject({ authorityRef: judgment.ref });
    expect(await resolve(`00000${VOL}-24-000001`)).toMatchObject({ authorityRef: filing.ref });
  });

  it("keeps a source hint from matching another source's authority", async () => {
    const result = await knowledge.resolve(asPrincipal(member), {
      citation: cite(1),
      sourceHint: "eurlex",
    });
    expect(result).toEqual({ status: "unresolved", reason: "authority_not_found" });
  });
});

describe("writer", () => {
  it("skips an unchanged record and replaces a changed one whole", async () => {
    const writer = knowledge.writer();
    expect(await writer.upsert(opinion(1))).toBe("unchanged");
    const changed = opinion(1, {
      citations: [{ text: cite(7), kind: "reporter" }],
      chunks: [{ sectionPath: null, text: `Rewritten ${tag}.` }],
    });
    expect(await writer.upsert(changed)).toBe("updated");
    expect(await knowledge.resolve(asPrincipal(member), { citation: cite(1) })).toMatchObject({
      status: "unresolved",
    });
    expect(await knowledge.resolve(asPrincipal(member), { citation: cite(7) })).toMatchObject({
      status: "ok",
    });
    const text = await knowledge.text(asPrincipal(member), opinion(1).ref, 0);
    expect(text?.chunks.map((c) => c.text)).toEqual([`Rewritten ${tag}.`]);
    await writer.upsert(opinion(1));
  });

  it("embeds chunks when it has a model, and again when the model changes", async () => {
    const seen: string[] = [];
    const embedder = (model: string): Embedder => ({
      model,
      async embed(texts) {
        seen.push(...texts);
        return texts.map(() => {
          const vector = new Array<number>(DIMENSIONS).fill(0);
          vector[0] = 1;
          return vector;
        });
      },
    });
    const record = opinion(6);
    const first = createKnowledge(pool, { embedder: embedder("m1") }).writer();
    expect(await first.upsert(record)).toBe("added");
    expect(await first.upsert(record)).toBe("unchanged");
    expect(seen).toHaveLength(2);
    // A change that leaves the text alone embeds nothing new.
    expect(await first.upsert({ ...record, title: `${record.title} (renamed)` })).toBe("updated");
    expect(seen).toHaveLength(2);
    await first.upsert(record);
    const second = createKnowledge(pool, { embedder: embedder("m2") }).writer();
    expect(await second.upsert(record)).toBe("updated");
    expect(seen).toHaveLength(4);
    // A run with no model, or a model that is down, keeps the vectors it found.
    expect(await knowledge.writer().upsert(record)).toBe("unchanged");
    const down: Embedder = {
      model: "m3",
      embed: async () => {
        throw new EmbedUnavailable("down");
      },
    };
    expect(await createKnowledge(pool, { embedder: down }).writer().upsert(record)).toBe(
      "unchanged",
    );
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from knowledge.authority_chunk c
         join knowledge.authority a on a.id = c.authority_id
        where a.ref = $1 and c.embedding_model = 'm2'`,
      [record.ref],
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it("adds nothing when the same files are loaded twice", async () => {
    const folder = mkdtempSync(join(tmpdir(), "knowledge-load-"));
    try {
      const record = { ...filing, ref: `edgar:accession:00001${VOL}-24-000009` };
      writeFileSync(join(folder, "a.json"), JSON.stringify([record]));
      const writer = knowledge.writer();
      expect(await sync(createFileLoader("edgar", folder), writer)).toMatchObject({ added: 1 });
      expect(await sync(createFileLoader("edgar", folder), writer)).toMatchObject({
        added: 0,
        updated: 0,
        unchanged: 1,
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps the loader role away from the API's login", async () => {
    const { rows } = await pool.query<{ api: boolean; loader: boolean }>(
      `select pg_has_role('legallabs_api', 'legallabs_knowledge', 'member') as api,
              pg_has_role('legallabs_loader', 'legallabs_knowledge', 'member') as loader`,
    );
    expect(rows[0]).toEqual({ api: false, loader: true });
  });

  it("leaves tenants no way to write public law", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role legallabs_app");
      await expect(
        client.query(
          `insert into knowledge.authority (ref, source, title, content_hash)
           values ('us_caselaw:cap:x', 'us_caselaw', 'x', repeat('0', 64))`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("search", () => {
  const search = (q: string, sources: { sourceId: SourceId; filter?: unknown }[]) =>
    knowledge.search(
      asPrincipal(member),
      q,
      sources.map((s) => ({ sourceId: s.sourceId, filter: s.filter ?? {} })),
      10,
    );

  it("finds passages by words, within the chosen sources only", async () => {
    const passages = await search(`plausible claim ${tag}2`, [{ sourceId: "us_caselaw" }]);
    expect(passages?.[0]).toMatchObject({
      authorityRef: `us_caselaw:cap:${tag}2`,
      source: "us_caselaw",
      sectionPath: "Opinion (majority)",
      citation: cite(2),
    });
    const elsewhere = await search(`plausible claim ${tag}2`, [{ sourceId: "eurlex" }]);
    expect(elsewhere?.some((p) => p.authorityRef.startsWith("us_caselaw"))).toBe(false);
  });

  it("puts the cited authority first when the query is a citation", async () => {
    const passages = await search(cite(3), [{ sourceId: "us_caselaw" }]);
    expect(passages?.[0]?.authorityRef).toBe(`us_caselaw:cap:${tag}3`);
  });

  it("applies court, date, form and CIK filters", async () => {
    const supreme = await search(`widgets ${tag}`, [
      { sourceId: "us_caselaw", filter: { courts: ["Supreme Court of the United States"] } },
    ]);
    expect(supreme?.length).toBeGreaterThan(0);
    expect(supreme?.every((p) => p.court === "Supreme Court of the United States")).toBe(true);
    const dated = await search(`widgets ${tag}`, [
      { sourceId: "us_caselaw", filter: { date_from: "2013-01-01", date_to: "2013-12-31" } },
    ]);
    expect(new Set(dated?.map((p) => p.authorityRef))).toEqual(new Set([`us_caselaw:cap:${tag}3`]));
    const forms = await search(`risk factors ${tag}`, [
      { sourceId: "edgar", filter: { forms: ["10-K"], ciks: [`${VOL}`] } },
    ]);
    expect(forms?.[0]?.authorityRef).toBe(filing.ref);
    const none = await search(`risk factors ${tag}`, [
      { sourceId: "edgar", filter: { forms: ["8-K"] } },
    ]);
    expect(none?.some((p) => p.authorityRef === filing.ref)).toBe(false);
  });

  it("refuses a filter that does not fit its source", async () => {
    expect(await search("x", [{ sourceId: "edgar", filter: { courts: ["x"] } }])).toBeNull();
  });

  it("answers nothing to someone who may not use sources", async () => {
    const reader = await seedMember(pool, { permissions: ["vaults.read"] });
    const sources = [{ sourceId: "us_caselaw" as const, filter: {} }];
    expect(await knowledge.search(asPrincipal(reader), `widgets ${tag}`, sources)).toBeNull();
    expect(await knowledge.resolve(asPrincipal(reader), { citation: cite(2) })).toBeNull();
    expect(await knowledge.presets(asPrincipal(reader), "edgar")).toBeNull();
    const created = await knowledge.createPreset(asPrincipal(reader), "edgar", {
      name: "x",
      filter: {},
      isDefault: false,
    });
    expect(created).toEqual({ ok: false, reason: "FORBIDDEN" });
  });
});

describe("knowledge port for threads", () => {
  const caller = () => ({ userId: member.userId, workspaceId: member.workspaceId });

  it("lists the sources and returns passages with the string to cite", async () => {
    const port = knowledgePort(knowledge);
    expect((await port.list(caller())).map((s) => s.id)).toEqual(["us_caselaw", "edgar", "eurlex"]);
    const found = await port.search(
      caller(),
      [{ source_id: "eurlex", filter: { doc_types: ["regulation"] } }, { source_id: "kb:x" }],
      `consent ${tag}`,
      5,
    );
    expect(found[0]).toMatchObject({
      authority_id: regulation.ref,
      source_id: "eurlex",
      citation_string: `CELEX:3${VOL}R0001`,
      pin: "Article 6",
    });
  });

  it("returns nothing for sources it does not serve or filters that don't fit", async () => {
    const port = knowledgePort(knowledge);
    const odd = [{ source_id: "web" }, { source_id: "edgar", filter: { courts: ["x"] } }];
    expect(await port.search(caller(), odd, "risk", 5)).toEqual([]);
  });
});

describe("knowledge API", () => {
  const app = createApp({
    auth: createAuth(pool),
    documents: testDocuments(pool),
    threads: testThreads(pool, testDocuments(pool), {}, noVaults, knowledgePort(knowledge)),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    knowledge,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Seeded) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const get = (cookie: string, path: string) =>
    app.request(`/api/v1/knowledge${path}`, { headers: { cookie } });
  const send = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/knowledge${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // Shapes are asserted by the expectations; the cast only lets the test read fields.
  const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
  const resolve = (cookie: string, citation_string: string) =>
    json<{ href: string | null }>(send(cookie, "POST", "/citations/resolve", { citation_string }));
  type Items<T> = { items: T[] };
  type Preset = { filter: { id: string } };

  it("needs a session", async () => {
    expect((await get("", "/sources")).status).toBe(401);
    const res = await send("", "POST", "/citations/resolve", { citation_string: "x" });
    expect(res.status).toBe(401);
  });

  it("lists the sources with their filter schemas and facets", async () => {
    const cookie = await signIn(member);
    const list = await json<Items<{ id: string }>>(get(cookie, "/sources"));
    expect(list.items.map((s) => s.id)).toEqual(["us_caselaw", "edgar", "eurlex"]);
    const detail = await json<{
      filter_schema: unknown;
      facets: { courts: { value: string }[] };
    }>(get(cookie, "/sources/us_caselaw"));
    expect(detail.filter_schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(detail.facets.courts.map((f) => f.value)).toContain(
      "Supreme Court of the United States",
    );
    expect((await get(cookie, "/sources/bailii")).status).toBe(404);
  });

  it("searches with filters keyed by source, up to five sources", async () => {
    const cookie = await signIn(member);
    const q = encodeURIComponent(`risk ${tag}`);
    const filters = encodeURIComponent(JSON.stringify({ edgar: { forms: ["10-K"] } }));
    const res = await get(cookie, `/search?q=${q}&source=edgar&filters=${filters}`);
    expect(res.status).toBe(200);
    expect((await json<{ passages: unknown[] }>(res)).passages[0]).toMatchObject({
      authority_ref: filing.ref,
      doc_type: "10-K",
    });
    const six = Array.from({ length: 6 }, (_, i) => `source=s${i}`).join("&");
    expect(await (await get(cookie, `/search?q=x&${six}`)).json()).toMatchObject({
      code: "TOO_MANY_SOURCES",
    });
    const wrong = encodeURIComponent(JSON.stringify({ edgar: { courts: ["x"] } }));
    const bad = await get(cookie, `/search?q=x&source=edgar&filters=${wrong}`);
    expect(await bad.json()).toMatchObject({ code: "INVALID_FILTER" });
    const stray = encodeURIComponent(JSON.stringify({ eurlex: {} }));
    expect((await get(cookie, `/search?q=x&source=edgar&filters=${stray}`)).status).toBe(400);
  });

  it("links a resolved citation and never an unresolved one", async () => {
    const cookie = await signIn(member);
    const ok = await resolve(cookie, cite(2));
    expect(ok).toMatchObject({ status: "ok", authority_ref: `us_caselaw:cap:${tag}2` });
    expect(ok.href).toMatch(/^\/knowledge\/authorities\//);
    for (const written of [`${VOL + 600} U.S. 1`, cite(9), "not a citation at all"]) {
      expect(await resolve(cookie, written)).toMatchObject({ status: "unresolved", href: null });
    }
  });

  it("serves an authority and its text page by page", async () => {
    const cookie = await signIn(member);
    const ref = encodeURIComponent(regulation.ref);
    const detail = await (await get(cookie, `/authorities/${ref}`)).json();
    expect(detail).toMatchObject({
      ref: regulation.ref,
      sections: ["Article 1", "Article 6"],
      attribution: "© European Union, https://eur-lex.europa.eu",
    });
    const text = await json<{ chunks: { section_path: string }[]; next_cursor: number | null }>(
      get(cookie, `/authorities/${ref}/text`),
    );
    expect(text.chunks.map((c) => c.section_path)).toEqual(["Article 1", "Article 6"]);
    expect(text.next_cursor).toBeNull();
    expect((await get(cookie, "/authorities/us_caselaw%3Acap%3Anone")).status).toBe(404);
  });

  it("keeps saved filters per person, with one default per source", async () => {
    const cookie = await signIn(member);
    const create = (name: string, filter: unknown, isDefault = false) =>
      send(cookie, "POST", "/sources/edgar/filters", { name, filter, default: isDefault });
    const first = await json<Preset>(create("Annual reports", { forms: ["10-K"] }, true));
    const second = await json<Preset>(create("Current reports", { forms: ["8-K"] }, true));
    expect((await create("Annual reports", { forms: ["10-K"] })).status).toBe(409);
    expect(await (await create("Bad", { courts: ["x"] })).json()).toMatchObject({
      code: "INVALID_FILTER",
    });
    const listed = await json<Items<{ name: string; default: boolean }>>(
      get(cookie, "/sources/edgar/filters"),
    );
    expect(listed.items.map((p) => [p.name, p.default])).toEqual([
      ["Current reports", true],
      ["Annual reports", false],
    ]);

    const other = await seedMember(pool);
    const otherCookie = await signIn(other);
    expect((await json<Items<unknown>>(get(otherCookie, "/sources/edgar/filters"))).items).toEqual(
      [],
    );
    expect((await send(otherCookie, "DELETE", `/filters/${first.filter.id}`)).status).toBe(404);

    const renamed = await send(cookie, "PATCH", `/filters/${second.filter.id}`, { name: "8-Ks" });
    expect((await json<Preset>(renamed)).filter).toMatchObject({ name: "8-Ks", default: true });
    expect((await send(cookie, "DELETE", `/filters/${first.filter.id}`)).status).toBe(204);
    const trail = await auditTrail(pool, member.workspaceId);
    expect(trail.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "knowledge.filter_preset.created",
        "knowledge.filter_preset.updated",
        "knowledge.filter_preset.deleted",
      ]),
    );
  });
});
