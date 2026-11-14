import { z } from "zod";
import { createHttp, type Http } from "./http.js";
import type { AuthorityRecord, CitationKind } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { type Chunk, chunkText, htmlToText, splitSections } from "./text.js";

const SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";
const CELLAR = "https://publications.europa.eu/resource/celex";

/** Popular names the official identifiers never carry. Kept in the repository, reviewed by hand. */
export const EU_ALIASES: Record<string, readonly string[]> = {
  "32016R0679": ["GDPR", "General Data Protection Regulation"],
  "31995L0046": ["Data Protection Directive"],
  "32022R2065": ["DSA", "Digital Services Act"],
  "32022R1925": ["DMA", "Digital Markets Act"],
  "32024R1689": ["AI Act", "Artificial Intelligence Act"],
  "32002L0058": ["ePrivacy Directive"],
  "62012CJ0131": ["Google Spain"],
  "62014CJ0362": ["Schrems I"],
  "62018CJ0311": ["Schrems II"],
};

const CELEX = /^([0-9CE])(\d{4})([A-Z]{1,2})(\d{4})$/;
const LEGISLATION: Record<string, string> = { R: "regulation", L: "directive", D: "decision" };
const COURTS: Record<string, string> = { C: "Court of Justice", T: "General Court" };

export function celexParts(celex: string) {
  const match = CELEX.exec(celex);
  if (!match) return null;
  const sector = match[1] ?? "";
  const year = match[2] ?? "";
  const type = match[3] ?? "";
  const number = match[4] ?? "";
  let docType: string | undefined;
  if (sector === "3") docType = LEGISLATION[type];
  else if (sector === "6" && type.endsWith("J")) docType = "judgment";
  else if (sector === "6" && type.endsWith("C")) docType = "opinion";
  const court = sector === "6" ? COURTS[type[0] ?? ""] : undefined;
  // 62012CJ0131 is case C-131/12.
  const caseNumber = court ? `${type[0]}-${Number(number)}/${year.slice(2)}` : undefined;
  return { sector, year, type, number, docType, court, caseNumber };
}

const bindings = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        date: z.object({ value: z.string() }).optional(),
        title: z.object({ value: z.string() }).optional(),
        same: z.object({ value: z.string() }).optional(),
      }),
    ),
  }),
});

// Only a CELEX that passed the pattern goes in, so a subset file can't change the query.
const metadataQuery = (celex: string) => `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?date ?title ?same WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^<http://www.w3.org/2001/XMLSchema#string> .
  OPTIONAL { ?work cdm:work_date_document ?date }
  OPTIONAL { ?work owl:sameAs ?same }
  OPTIONAL { ?exp cdm:expression_belongs_to_work ?work ;
                  cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
                  cdm:expression_title ?title }
} LIMIT 50`;

const ACT_FORMS = [
  /^(?:regulation|directive|decision)\s*\((?:eu|ec|eec|euratom)\)\s*(?:no\.?\s*)?\d{1,4}\/\d{1,4}/i,
  /^(?:regulation|directive|decision)\s*(?:no\.?\s*)?\d{1,4}\/\d{1,4}\/(?:eu|ec|eec|euratom)\b/i,
];

export interface EurLexMetadata {
  date?: string;
  title?: string;
  ecli?: string;
}

export function readMetadata(raw: unknown): EurLexMetadata {
  const rows = bindings.parse(raw).results.bindings;
  const date = rows.find((r) => r.date)?.date?.value;
  const title = rows.find((r) => r.title)?.title?.value;
  const ecli = rows
    .map((r) => decodeURIComponent(r.same?.value ?? ""))
    .map(
      (value) => /(ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,25})(?:_\d+)?$/.exec(value)?.[1],
    )
    .find((value) => value !== undefined);
  return {
    ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}),
    ...(title ? { title } : {}),
    ...(ecli ? { ecli } : {}),
  };
}

export function eurLexRecord(
  celex: string,
  metadata: EurLexMetadata,
  html: string,
): AuthorityRecord {
  const parts = celexParts(celex);
  if (!parts) throw new Error(`not a CELEX number: ${celex}`);
  // Judgment titles come as "Judgment…#Parties#Subject…"; the parties are what people say.
  const titleParts = (metadata.title ?? celex).split("#").map((part) => part.trim());
  const heading = titleParts[0] ?? celex;
  const parties = titleParts[1];
  const title =
    parts.docType === "judgment" && parties
      ? `${parties.replace(/\.$/, "")} (${parts.caseNumber})`
      : heading;
  const sections = splitSections(htmlToText(html), /^(Article \d+[a-z]?)$/, "Preamble");
  const chunks: Chunk[] = sections.flatMap((s) => chunkText(s.body, s.title));
  const citations: { text: string; kind: CitationKind }[] = [
    { text: `CELEX:${celex}`, kind: "celex" },
  ];
  if (metadata.ecli) citations.push({ text: metadata.ecli, kind: "ecli" });
  if (parts.caseNumber) {
    citations.push({ text: parts.caseNumber, kind: "docket" });
    citations.push({ text: `Case ${parts.caseNumber}`, kind: "docket" });
  }
  for (const form of ACT_FORMS) {
    const act = form.exec(heading)?.[0];
    if (act) citations.push({ text: act, kind: "act" });
  }
  for (const alias of EU_ALIASES[celex] ?? []) citations.push({ text: alias, kind: "alias" });
  return {
    ref: `eurlex:celex:${celex}`,
    title: title.slice(0, 1000),
    ...(parts.court ? { court: parts.court } : {}),
    jurisdiction: "EU",
    ...(parts.docType ? { docType: parts.docType } : {}),
    ...(metadata.date ? { decidedOn: metadata.date } : {}),
    url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`,
    citations,
    sections: sections.map((s) => s.title).filter((s) => s.startsWith("Article ")),
    meta: {
      celex,
      ...(metadata.ecli ? { ecli: metadata.ecli } : {}),
      ...(parts.caseNumber ? { case_number: parts.caseNumber } : {}),
      full_title: (metadata.title ?? "").replaceAll("#", " ").slice(0, 4000),
      licence: "Commission Decision 2011/833/EU; © European Union",
    },
    chunks: chunks.length > 0 ? chunks : [{ sectionPath: null, text: title }],
  };
}

export interface EurLexOptions {
  /** CELEX numbers to load, such as "32016R0679". */
  celex: readonly string[];
  http?: Http;
}

/** CELLAR, the Publications Office's open repository: SPARQL for metadata, XHTML for text. */
export function createEurLexLoader(options: EurLexOptions): Loader {
  const http = options.http ?? createHttp({ perSecond: 1 });
  return {
    source: "eurlex",
    async *records() {
      for (const celex of options.celex) {
        if (!CELEX.test(celex)) {
          yield { failed: celex, reason: "not a CELEX number" };
          continue;
        }
        try {
          const query = new URLSearchParams({ query: metadataQuery(celex) });
          const metadata = readMetadata(
            await http.json(`${SPARQL}?${query}`, { accept: "application/sparql-results+json" }),
          );
          const html = await http.text(`${CELLAR}/${celex}`, {
            accept: "application/xhtml+xml, text/html;q=0.9",
            "accept-language": "eng",
          });
          yield eurLexRecord(celex, metadata, html);
        } catch (err) {
          yield failure(celex, err);
        }
      }
    },
  };
}
