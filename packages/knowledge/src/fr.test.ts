import { describe, expect, it } from "vitest";
import { createFederalRegisterLoader } from "./fr.js";
import { type AuthorityRecord, authorityRecord } from "./record.js";
import { filterSchemas } from "./sources.js";
import { loaderFor, subsetSchema } from "./subset.js";
import { collect, fakeHttp } from "./testing.js";

const API = "https://www.federalregister.gov/api/v1/documents/";
const BODY = "https://www.federalregister.gov/documents/full_text/html/2001/02/03/2001-00001.html";

// Synthetic: a made-up rule shaped like the Federal Register's document JSON.
const document = (more: Record<string, unknown> = {}) => ({
  document_number: "2001-00001",
  title: "Widget Labelling",
  type: "Proposed Rule",
  citation: "66 FR 1000",
  start_page: 1000,
  end_page: 1004,
  publication_date: "2001-02-03",
  agencies: [
    { raw_name: "WIDGET COMMISSION", name: "Widget Commission", slug: "widget-commission" },
    { raw_name: "OFFICE OF GADGETS" },
  ],
  regulation_id_numbers: ["1234-AB56"],
  docket_ids: ["Docket No. WC-01-1"],
  html_url: "https://www.federalregister.gov/documents/2001/02/03/2001-00001/widget-labelling",
  body_html_url: BODY,
  ...more,
});

const load = (routes: Record<string, unknown>, documents = ["2001-00001"], seen: string[] = []) =>
  collect(createFederalRegisterLoader({ documents, http: fakeHttp(routes, seen) }));

describe("Federal Register loader", () => {
  it("indexes a document by page citation, document number and RIN", async () => {
    const [record] = await load({
      [`${API}2001-00001.json`]: document(),
      [BODY]: "<h4>SUMMARY:</h4><p>Every widget must carry a label.</p><script>x()</script>",
    });
    expect(record).toMatchObject({
      ref: "fr:doc:2001-00001",
      title: "Widget Labelling",
      court: "Widget Commission",
      jurisdiction: "US",
      docType: "proposed_rule",
      decidedOn: "2001-02-03",
      url: "https://www.federalregister.gov/documents/2001/02/03/2001-00001/widget-labelling",
      firstPage: 1000,
      lastPage: 1004,
      citations: [
        { text: "66 FR 1000", kind: "reporter" },
        { text: "2001-00001", kind: "docket" },
        { text: "FR Doc. 2001-00001", kind: "docket" },
        { text: "RIN 1234-AB56", kind: "docket" },
      ],
      meta: {
        agencies: ["widget-commission"],
        rins: ["1234-AB56"],
        docket_ids: ["Docket No. WC-01-1"],
      },
      chunks: [{ sectionPath: null, text: "SUMMARY:\nEvery widget must carry a label." }],
    });
    expect(authorityRecord.safeParse(record).success).toBe(true);
  });

  it("never fetches text from another host", async () => {
    for (const odd of [
      "https://evil.example/x.html",
      "http://www.federalregister.gov/x.html",
      "https://www.federalregister.gov.evil.example/x",
      "https://user@evil.example/",
    ]) {
      const seen: string[] = [];
      const [item] = await load(
        { [`${API}2001-00001.json`]: document({ body_html_url: odd }), [odd]: "text" },
        ["2001-00001"],
        seen,
      );
      expect(item).toMatchObject({ failed: "2001-00001" });
      expect(seen).toEqual([`${API}2001-00001.json`]);
    }
  });

  it("keeps a document without a page citation, and links nowhere off the site", async () => {
    const [record] = await load({
      [`${API}2001-00001.json`]: document({
        citation: null,
        start_page: null,
        end_page: null,
        html_url: "https://evil.example/",
        regulation_id_numbers: null,
        type: "Presidential Document",
      }),
      [BODY]: "<p>Text.</p>",
    });
    expect(record).toMatchObject({ docType: "presidential_document" });
    expect((record as AuthorityRecord).url).toBe("https://www.federalregister.gov/d/2001-00001");
    expect((record as AuthorityRecord).citations.map((c) => c.kind)).toEqual(["docket", "docket"]);
    expect(record).not.toHaveProperty("firstPage");
  });

  it("refuses odd document numbers and answers for another document", async () => {
    const seen: string[] = [];
    const items = await load(
      { [`${API}2001-00002.json`]: document() },
      ["../agencies", "2001-00002", "2001-00003"],
      seen,
    );
    expect(items).toEqual([
      { failed: "../agencies", reason: "not a document number" },
      expect.objectContaining({ failed: "2001-00002" }),
      expect.objectContaining({ failed: "2001-00003" }),
    ]);
    expect(seen).toHaveLength(2);
  });

  it("takes document numbers from a subset and filters by agency, type, RIN and docket", () => {
    expect(subsetSchema.safeParse({ fr: { documents: ["E9-12345"] } }).success).toBe(true);
    expect(subsetSchema.safeParse({ fr: { documents: ["a/b"] } }).success).toBe(false);
    expect(loaderFor("fr", {}, {})?.source).toBe("fr");
    const filter = {
      agencies: ["widget-commission"],
      doc_types: ["rule", "proposed_rule", "notice"],
      rin: ["1234-AB56"],
      docket_ids: ["WC-01-1"],
      date_from: "2001-01-01",
    };
    expect(filterSchemas.fr.safeParse(filter).success).toBe(true);
    expect(filterSchemas.fr.safeParse({ courts: ["x"] }).success).toBe(false);
  });
});
