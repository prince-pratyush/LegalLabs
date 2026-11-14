import { describe, expect, it } from "vitest";
import { capLocation, createCapLoader } from "./cap.js";
import { courtListenerUrl, createCourtListenerLoader } from "./courtlistener.js";
import { createEdgarLoader, pickFilings } from "./edgar.js";
import { celexParts, createEurLexLoader, readMetadata } from "./eurlex.js";
import { createHttp, type Http, NotFound, SourceUnavailable } from "./http.js";
import type { AuthorityRecord } from "./record.js";
import { isFailure, type Loader, type LoadFailure } from "./sources.js";

/** Canned answers by URL prefix; anything else is a 404, as a missing file would be. */
function fakeHttp(routes: Record<string, unknown>, seen: string[] = []): Http {
  const find = (url: string) => {
    seen.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (key === undefined) throw new NotFound(url);
    return routes[key];
  };
  return {
    text: async (url) => {
      const body = find(url);
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    json: async (url) => find(url),
  };
}

async function collect(loader: Loader) {
  const items: (AuthorityRecord | LoadFailure)[] = [];
  for await (const item of loader.records()) items.push(item);
  return items;
}

// Synthetic: a made-up case shaped like a Caselaw Access Project file.
const capCase = (id: number, cite: string) => ({
  id,
  name: "DOE, PETITIONER v. ROE",
  name_abbreviation: "Doe v. Roe",
  decision_date: "2001-02-03",
  docket_number: "No. 00-1",
  first_page: "10",
  last_page: "20",
  citations: [
    { type: "official", cite },
    { type: "parallel", cite: "99 S. Ct. 9" },
    { type: "vendor", cite: "2001 U.S. LEXIS 1" },
  ],
  court: { name: "Supreme Court of the United States" },
  jurisdiction: { name_long: "United States" },
  cites_to: [{ cite: "1 U. S. 1" }],
  casebody: {
    head_matter: "Syllabus text.",
    opinions: [
      { type: "majority", author: "Justice Example,", text: "Held: a widget is a gadget." },
    ],
  },
});

describe("Caselaw Access Project loader", () => {
  it("maps a reporter citation to its CAP folder", () => {
    expect(capLocation("556 U.S. 662")).toEqual({ reporter: "us", volume: 556, page: 662 });
    expect(capLocation("129 S. Ct. 1937")).toEqual({ reporter: "s-ct", volume: 129, page: 1937 });
    expect(capLocation("Regulation (EU) 2016/679")).toBeNull();
  });

  it("takes the case on the page that carries the citation", async () => {
    const seen: string[] = [];
    const http = fakeHttp(
      {
        "https://static.case.law/us/500/cases/0010-01.json": capCase(1, "500 U.S. 9"),
        "https://static.case.law/us/500/cases/0010-02.json": capCase(2, "500 U.S. 10"),
      },
      seen,
    );
    const [record] = await collect(createCapLoader({ cites: ["500 U.S. 10"], http }));
    expect(seen).toHaveLength(2);
    expect(record).toMatchObject({
      ref: "us_caselaw:cap:2",
      title: "Doe v. Roe",
      court: "Supreme Court of the United States",
      decidedOn: "2001-02-03",
      firstPage: 10,
      lastPage: 20,
      citations: [
        { text: "500 U.S. 10", kind: "reporter" },
        { text: "99 S. Ct. 9", kind: "parallel" },
      ],
      chunks: [
        { sectionPath: "Syllabus", text: "Syllabus text." },
        { sectionPath: "Opinion (majority, Justice Example)", text: "Held: a widget is a gadget." },
      ],
    });
  });

  it("reports a missing case and carries on", async () => {
    const http = fakeHttp({
      "https://static.case.law/us/1/cases/0002-01.json": capCase(3, "1 U.S. 2"),
    });
    const items = await collect(createCapLoader({ cites: ["1 U.S. 1", "x", "1 U.S. 2"], http }));
    expect(items.map((i) => (isFailure(i) ? `failed ${i.failed}` : i.ref))).toEqual([
      "failed 1 U.S. 1",
      "failed x",
      "us_caselaw:cap:3",
    ]);
  });
});

describe("CourtListener loader", () => {
  it("builds a record from the matching cluster and its opinions", async () => {
    const http = fakeHttp({
      "https://www.courtlistener.com/api/rest/v4/search/": {
        results: [
          {
            cluster_id: 7,
            caseName: "Doe v. Roe",
            court: "Supreme Court of the United States",
            court_id: "scotus",
            dateFiled: "2020-01-02",
            docketNumber: "19-1",
            citation: ["590 U.S. 1", "140 S. Ct. 1"],
            absolute_url: "/opinion/7/doe-v-roe/",
            opinions: [{ id: 70, type: "majority" }],
          },
        ],
      },
      "https://www.courtlistener.com/api/rest/v4/opinions/70/": {
        plain_text: "Synthetic opinion.",
      },
    });
    const [record] = await collect(
      createCourtListenerLoader({ cites: ["590 U.S. 1"], token: "t", http }),
    );
    expect(record).toMatchObject({
      ref: "us_caselaw:cl:7",
      url: "https://www.courtlistener.com/opinion/7/doe-v-roe/",
      citations: [
        { text: "590 U.S. 1", kind: "reporter" },
        { text: "140 S. Ct. 1", kind: "parallel" },
      ],
      chunks: [{ sectionPath: "Opinion (majority)", text: "Synthetic opinion." }],
    });
  });
});

describe("CourtListener links", () => {
  it("stays on CourtListener whatever the API sends", () => {
    expect(courtListenerUrl("/opinion/7/x/")).toBe("https://www.courtlistener.com/opinion/7/x/");
    for (const odd of ["@evil.example/x", "//evil.example/x", "https://evil.example/"]) {
      expect(() => courtListenerUrl(odd)).toThrow();
    }
  });
});

describe("EUR-Lex loader", () => {
  it("reads type, court and case number from a CELEX number", () => {
    expect(celexParts("32016R0679")).toMatchObject({ docType: "regulation" });
    expect(celexParts("31995L0046")).toMatchObject({ docType: "directive" });
    expect(celexParts("62012CJ0131")).toMatchObject({
      docType: "judgment",
      court: "Court of Justice",
      caseNumber: "C-131/12",
    });
    expect(celexParts("not celex")).toBeNull();
  });

  it("takes the ECLI from the work's identifiers", () => {
    const meta = readMetadata({
      results: {
        bindings: [
          { date: { value: "2014-05-13" }, same: { value: "http://x/celex/62012CJ0131" } },
          { same: { value: "http://x/ecli/ECLI%3AEU%3AC%3A2014%3A317_1" } },
          { title: { value: "Judgment#Parties v Agency.#Subject" } },
        ],
      },
    });
    expect(meta).toEqual({
      date: "2014-05-13",
      title: "Judgment#Parties v Agency.#Subject",
      ecli: "ECLI:EU:C:2014:317",
    });
  });

  it("splits an act into articles and indexes its citation forms", async () => {
    const http = fakeHttp({
      "https://publications.europa.eu/webapi/rdf/sparql": {
        results: {
          bindings: [
            {
              date: { value: "2016-04-27" },
              title: { value: "Regulation (EU) 2016/679 of the European Parliament (synthetic)" },
            },
          ],
        },
      },
      "https://publications.europa.eu/resource/celex/32016R0679":
        "<html><body><p>Whereas recital.</p><p class='oj-ti-art'>Article 1</p>" +
        "<p>Subject matter text.</p><p class='oj-ti-art'>Article 2</p><p>Scope text.</p></body></html>",
    });
    const [record, bad] = await collect(createEurLexLoader({ celex: ["32016R0679", "bad"], http }));
    expect(bad).toEqual({ failed: "bad", reason: "not a CELEX number" });
    expect(record).toMatchObject({
      ref: "eurlex:celex:32016R0679",
      docType: "regulation",
      decidedOn: "2016-04-27",
      sections: ["Article 1", "Article 2"],
      citations: [
        { text: "CELEX:32016R0679", kind: "celex" },
        { text: "Regulation (EU) 2016/679", kind: "act" },
        { text: "GDPR", kind: "alias" },
        { text: "General Data Protection Regulation", kind: "alias" },
      ],
    });
    expect((record as AuthorityRecord).chunks.map((c) => c.sectionPath)).toEqual([
      "Preamble",
      "Article 1",
      "Article 2",
    ]);
  });
});

describe("EDGAR loader", () => {
  const submissions = {
    cik: "0000000042",
    name: "Example Widgets Inc",
    tickers: ["EXW"],
    filings: {
      recent: {
        accessionNumber: ["0000000042-24-000003", "0000000042-24-000002", "0000000042-24-000001"],
        filingDate: ["2024-03-01", "2024-02-01", "2024-01-01"],
        form: ["8-K", "10-K", "10-K"],
        primaryDocument: ["a.htm", "../../etc/passwd", "b10k.htm"],
      },
    },
  };

  it("refuses to run without a declared contact, as the SEC asks", () => {
    expect(() => createEdgarLoader({ companies: [], userAgent: "LegalLabs" })).toThrow(/contact/);
  });

  it("picks the newest wanted forms and skips unsafe document names", () => {
    const picked = pickFilings(submissions, ["10-K"], 5);
    expect(picked.map((f) => f.accession)).toEqual(["0000000042-24-000001"]);
  });

  it("indexes a filing by accession and by company, form and date", async () => {
    const http = fakeHttp({
      "https://data.sec.gov/submissions/CIK0000000042.json": submissions,
      "https://www.sec.gov/Archives/edgar/data/42/000000004224000003/a.htm":
        "<p>Cover page</p><p>Item 1.01 Entry into a Material Definitive Agreement</p><p>Terms.</p>",
    });
    const loader = createEdgarLoader({
      companies: [{ cik: "42", forms: ["8-K"], limit: 1 }],
      userAgent: "Example Operator ops@example.org",
      http,
    });
    const [record] = await collect(loader);
    expect(record).toMatchObject({
      ref: "edgar:accession:0000000042-24-000003",
      title: "Example Widgets Inc 8-K (2024-03-01)",
      docType: "8-K",
      citations: [
        { text: "0000000042-24-000003", kind: "accession" },
        { text: "CIK 42 8-K 2024-03-01", kind: "docket" },
      ],
      meta: { cik: "42", tickers: ["EXW"] },
    });
  });
});

describe("createHttp", () => {
  const response = (status: number, body = "", headers: Record<string, string> = {}) =>
    new Response(status === 404 || status === 429 ? null : body, { status, headers });

  it("fetches https only", async () => {
    const http = createHttp({ perSecond: 100, fetch: async () => response(200, "x") });
    await expect(http.text("http://example.org/")).rejects.toBeInstanceOf(SourceUnavailable);
  });

  it("waits as asked after a 429 and tries again", async () => {
    const slept: number[] = [];
    const answers = [response(429, "", { "retry-after": "2" }), response(200, "ok")];
    const http = createHttp({
      perSecond: 1000,
      fetch: async () => answers.shift() ?? response(500),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(await http.text("https://example.org/")).toBe("ok");
    expect(slept).toContain(2000);
  });

  it("names the agent and keeps requests apart", async () => {
    const agents: string[] = [];
    const slept: number[] = [];
    const http = createHttp({
      perSecond: 1,
      userAgent: "Operator ops@example.org",
      fetch: async (_url, init) => {
        agents.push(new Headers(init?.headers).get("user-agent") ?? "");
        return response(200, "{}");
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await http.json("https://example.org/a");
    await http.json("https://example.org/b");
    expect(agents).toEqual(["Operator ops@example.org", "Operator ops@example.org"]);
    expect(slept.some((ms) => ms > 900)).toBe(true);
  });

  it("follows a redirect on the same host and refuses one that leaves it", async () => {
    const hop = (location: string) => new Response(null, { status: 303, headers: { location } });
    const seen: string[] = [];
    const answers = [
      hop("/b"),
      new Response("ok"),
      hop("http://example.org/c"),
      new Response("up"),
    ];
    const http = createHttp({
      perSecond: 1000,
      fetch: async (url) => {
        seen.push(String(url));
        return answers.shift() ?? response(500);
      },
    });
    expect(await http.text("https://example.org/a")).toBe("ok");
    // Plain http on the same host is taken over https instead.
    expect(await http.text("https://example.org/a")).toBe("up");
    expect(seen.at(-1)).toBe("https://example.org/c");
    const away = createHttp({
      perSecond: 1000,
      fetch: async () => hop("https://elsewhere.example/"),
    });
    await expect(away.text("https://example.org/a")).rejects.toThrow(/redirected/);
  });

  it("stops EDGAR after the SEC refuses it", async () => {
    let calls = 0;
    const http: Http = {
      text: async () => "",
      json: async () => {
        calls++;
        throw new SourceUnavailable("data.sec.gov answered 403");
      },
    };
    const loader = createEdgarLoader({
      companies: [
        { cik: "1", forms: ["10-K"], limit: 1 },
        { cik: "2", forms: ["10-K"], limit: 1 },
      ],
      userAgent: "Operator ops@example.org",
      http,
    });
    expect(await collect(loader)).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("turns a 404 into NotFound and refuses bodies over the cap", async () => {
    const missing = createHttp({ perSecond: 100, fetch: async () => response(404) });
    await expect(missing.text("https://example.org/")).rejects.toBeInstanceOf(NotFound);
    const big = createHttp({
      perSecond: 100,
      maxBytes: 3,
      fetch: async () => response(200, "four"),
    });
    await expect(big.text("https://example.org/")).rejects.toBeInstanceOf(SourceUnavailable);
  });
});
