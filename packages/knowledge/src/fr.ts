import { z } from "zod";
import { createHttp, type Http } from "./http.js";
import type { AuthorityRecord, CitationKind } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { chunkText, htmlToText } from "./text.js";

const HOST = "www.federalregister.gov";
// A rule past this is mostly tables; the preamble and rule text come first.
const MAX_TEXT = 1_000_000;

/** "2020-17747", "E9-12345", "C1-2020-12345". It goes into a URL path. */
export const FR_DOCUMENT_NUMBER = /^[A-Za-z0-9]{1,4}(?:-\d{1,6}){1,2}$/;

const strings = z.array(z.string()).nullish();
const page = z.number().int().min(1).nullish();

const frDocument = z.object({
  document_number: z.string().regex(FR_DOCUMENT_NUMBER),
  title: z.string().min(1),
  type: z.string().min(1),
  citation: z.string().nullish(),
  start_page: page,
  end_page: page,
  publication_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  agencies: z.array(z.object({ name: z.string().nullish(), slug: z.string().nullish() })).nullish(),
  regulation_id_numbers: strings,
  docket_ids: strings,
  abstract: z.string().nullish(),
  html_url: z.string().nullish(),
  body_html_url: z.string().nullish(),
});
export type FederalRegisterDocument = z.infer<typeof frDocument>;

const DOC_TYPES: Record<string, string> = {
  Rule: "rule",
  "Proposed Rule": "proposed_rule",
  Notice: "notice",
  "Presidential Document": "presidential_document",
};

/** The URL, when it is plain https on the Federal Register's own host. */
function onSite(raw: string): string | null {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  return url && url.protocol === "https:" && url.host === HOST && !url.username ? url.href : null;
}

const some = (values: (string | null | undefined)[] | null | undefined) =>
  (values ?? []).flatMap((v) => (v ? [v.slice(0, 200)] : [])).slice(0, 50);

export function federalRegisterRecord(doc: FederalRegisterDocument, html: string): AuthorityRecord {
  const full = htmlToText(html);
  const text = full.slice(0, MAX_TEXT);
  const number = doc.document_number;
  const rins = some(doc.regulation_id_numbers);
  const citations: { text: string; kind: CitationKind }[] = [];
  if (doc.citation) citations.push({ text: doc.citation.slice(0, 500), kind: "reporter" });
  citations.push({ text: number, kind: "docket" });
  citations.push({ text: `FR Doc. ${number}`, kind: "docket" });
  for (const rin of rins) citations.push({ text: `RIN ${rin}`, kind: "docket" });
  const agency = doc.agencies?.find((a) => a.name)?.name;
  const chunks = chunkText(text || (doc.abstract ?? ""), null);
  const first = doc.start_page;
  const last = doc.end_page;
  return {
    ref: `fr:doc:${number}`,
    title: doc.title.slice(0, 1000),
    ...(agency ? { court: agency.slice(0, 200) } : {}),
    jurisdiction: "US",
    docType: DOC_TYPES[doc.type] ?? "other",
    decidedOn: doc.publication_date,
    url: onSite(doc.html_url ?? "") ?? `https://${HOST}/d/${number}`,
    citations,
    ...(first ? { firstPage: first, ...(last && last >= first ? { lastPage: last } : {}) } : {}),
    sections: [],
    meta: {
      document_number: number,
      agencies: some(doc.agencies?.map((a) => a.slug)),
      rins,
      docket_ids: some(doc.docket_ids),
      truncated: full.length > MAX_TEXT,
      licence: "Public domain (U.S. government work)",
    },
    chunks: chunks.length > 0 ? chunks : [{ sectionPath: null, text: doc.title.slice(0, 20_000) }],
  };
}

export interface FederalRegisterOptions {
  /** Document numbers to load, such as "2020-17747". */
  documents: readonly string[];
  http?: Http;
}

/** The federalregister.gov JSON API for metadata, and the HTML body it points to for text. */
export function createFederalRegisterLoader(options: FederalRegisterOptions): Loader {
  const http = options.http ?? createHttp({ perSecond: 2 });
  return {
    source: "fr",
    async *records() {
      for (const number of options.documents) {
        if (!FR_DOCUMENT_NUMBER.test(number)) {
          yield { failed: number, reason: "not a document number" };
          continue;
        }
        try {
          const doc = frDocument.parse(
            await http.json(`https://${HOST}/api/v1/documents/${number}.json`),
          );
          if (doc.document_number.toLowerCase() !== number.toLowerCase()) {
            throw new Error("the answer is for another document");
          }
          let html = "";
          if (doc.body_html_url) {
            // The address comes from the answer, so it is checked before anything is fetched.
            const body = onSite(doc.body_html_url);
            if (!body) throw new Error(`the text is not on ${HOST}`);
            html = await http.text(body, { accept: "text/html" });
          }
          yield federalRegisterRecord(doc, html);
        } catch (err) {
          yield failure(number, err);
        }
      }
    },
  };
}
