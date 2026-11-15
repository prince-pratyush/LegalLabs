import { z } from "zod";
import { createHttp, type Http, SourceUnavailable } from "./http.js";
import type { AuthorityRecord } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { type Chunk, chunkText, htmlToText, splitSections } from "./text.js";

// A filing past this is mostly exhibits and tables; the narrative comes first.
const MAX_TEXT = 400_000;

const submissions = z.object({
  cik: z.union([z.string(), z.number()]),
  name: z.string().min(1),
  tickers: z.array(z.string()).default([]),
  sicDescription: z.string().nullish(),
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      filingDate: z.array(z.string()),
      form: z.array(z.string()),
      primaryDocument: z.array(z.string()),
    }),
  }),
});

export interface Filing {
  cik: string;
  company: string;
  tickers: string[];
  sic: string | null;
  accession: string;
  form: string;
  filed: string;
  document: string;
}

/** The newest filings of the wanted forms, as the submissions file lists them. */
export function pickFilings(raw: unknown, forms: readonly string[], limit: number): Filing[] {
  const found = submissions.parse(raw);
  const recent = found.filings.recent;
  const cik = String(Number(found.cik));
  const picked: Filing[] = [];
  for (const [i, form] of recent.form.entries()) {
    if (picked.length >= limit) break;
    if (!forms.includes(form)) continue;
    const accession = recent.accessionNumber[i];
    const filed = recent.filingDate[i];
    const document = recent.primaryDocument[i];
    if (!accession || !filed || !document) continue;
    // Both go into a URL path, so only the shapes the SEC uses are let through.
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^[\w-]+(?:\.[\w-]+)*$/.test(document)) {
      continue;
    }
    picked.push({
      cik,
      company: found.name,
      tickers: found.tickers,
      sic: found.sicDescription ?? null,
      accession,
      form,
      filed,
      document,
    });
  }
  return picked;
}

export const filingUrl = (filing: Filing) =>
  `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accession.replaceAll("-", "")}/${filing.document}`;

export function edgarRecord(filing: Filing, html: string): AuthorityRecord {
  const text = htmlToText(html).slice(0, MAX_TEXT);
  const sections = splitSections(text, /^(Item\s+\d{1,2}[A-C]?)\.?(?:\s|$)/i, "Cover");
  const chunks: Chunk[] = sections.flatMap((s) => chunkText(s.body, s.title));
  const title = `${filing.company} ${filing.form} (${filing.filed})`;
  return {
    ref: `edgar:accession:${filing.accession}`,
    title: title.slice(0, 1000),
    jurisdiction: "US",
    docType: filing.form,
    ...(/^\d{4}-\d{2}-\d{2}$/.test(filing.filed) ? { decidedOn: filing.filed } : {}),
    url: filingUrl(filing),
    citations: [
      { text: filing.accession, kind: "accession" },
      { text: `CIK ${filing.cik} ${filing.form} ${filing.filed}`, kind: "docket" },
    ],
    sections: [...new Set(sections.map((s) => s.title).filter((s) => /^item/i.test(s)))],
    meta: {
      cik: filing.cik,
      company: filing.company,
      tickers: filing.tickers,
      sic: filing.sic,
      form: filing.form,
      truncated: text.length >= MAX_TEXT,
    },
    chunks: chunks.length > 0 ? chunks : [{ sectionPath: null, text: title }],
  };
}

export interface EdgarCompany {
  cik: string;
  forms: readonly string[];
  /** The newest this many filings of those forms. */
  limit: number;
}

export interface EdgarOptions {
  companies: readonly EdgarCompany[];
  /**
   * The SEC requires a declared User-Agent naming the operator and a contact
   * address. It belongs to whoever runs the sync, so there is no default.
   */
  userAgent: string;
  http?: Http;
}

// The SEC answers 403 to clients it is blocking; carrying on would only dig deeper.
const refused = (err: unknown) =>
  err instanceof SourceUnavailable && / answered 403$/.test(err.message);

export function createEdgarLoader(options: EdgarOptions): Loader {
  if (!/\S+@\S+\.\S+/.test(options.userAgent)) {
    throw new Error("SEC_USER_AGENT must name the operator and a contact email, as the SEC asks");
  }
  // The SEC's fair-access limit is ten a second; half that leaves room for others.
  const http = options.http ?? createHttp({ perSecond: 5, userAgent: options.userAgent });
  return {
    source: "edgar",
    async *records() {
      for (const company of options.companies) {
        const cik = company.cik.replace(/^0+/, "");
        if (!/^\d{1,10}$/.test(cik)) {
          yield { failed: company.cik, reason: "not a CIK" };
          continue;
        }
        let filings: Filing[];
        try {
          const raw = await http.json(
            `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`,
          );
          filings = pickFilings(raw, company.forms, company.limit);
        } catch (err) {
          yield failure(company.cik, err);
          if (refused(err)) return;
          continue;
        }
        for (const filing of filings) {
          try {
            yield edgarRecord(filing, await http.text(filingUrl(filing)));
          } catch (err) {
            yield failure(filing.accession, err);
            if (refused(err)) return;
          }
        }
      }
    },
  };
}
