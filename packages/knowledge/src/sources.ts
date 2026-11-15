import { z } from "zod";
import type { AuthorityRecord } from "./record.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const list = (item: z.ZodString) => z.array(item).min(1).max(50);
const label = z.string().min(1).max(200);

const dates = { date_from: isoDate.optional(), date_to: isoDate.optional() };

/** Each source's filters. Unknown keys are refused, so a typo never silently widens a search. */
export const filterSchemas = {
  us_caselaw: z.strictObject({
    courts: list(label).optional(),
    jurisdictions: list(label).optional(),
    ...dates,
  }),
  edgar: z.strictObject({
    forms: list(label).optional(),
    ciks: list(z.string().regex(/^\d{1,10}$/)).optional(),
    filed_from: isoDate.optional(),
    filed_to: isoDate.optional(),
  }),
  eurlex: z.strictObject({
    doc_types: z
      .array(z.enum(["regulation", "directive", "decision", "judgment", "opinion"]))
      .min(1)
      .optional(),
    ...dates,
  }),
} as const;

export type SourceId = keyof typeof filterSchemas;

export interface SourceInfo {
  id: SourceId;
  name: string;
  group: "public_law";
  mode: "indexed" | "hybrid";
  jurisdiction: string;
  termsUrl: string;
  /** Shown beside every passage, as the source's licence asks. */
  attribution: string;
}

export const SOURCES: readonly SourceInfo[] = [
  {
    id: "us_caselaw",
    name: "US case law",
    group: "public_law",
    mode: "indexed",
    jurisdiction: "US",
    termsUrl: "https://case.law/about/",
    attribution: "Caselaw Access Project (CC0) and CourtListener, Free Law Project",
  },
  {
    id: "edgar",
    name: "SEC EDGAR filings",
    group: "public_law",
    mode: "hybrid",
    jurisdiction: "US",
    termsUrl: "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
    attribution: "U.S. Securities and Exchange Commission, EDGAR",
  },
  {
    id: "eurlex",
    name: "EUR-Lex",
    group: "public_law",
    mode: "indexed",
    jurisdiction: "EU",
    termsUrl: "https://eur-lex.europa.eu/content/legal-notice/legal-notice.html",
    attribution: "© European Union, https://eur-lex.europa.eu",
  },
];

export const isSourceId = (id: string): id is SourceId => Object.hasOwn(filterSchemas, id);

/** One subset item that could not be loaded; the sync carries on with the rest. */
export interface LoadFailure {
  failed: string;
  reason: string;
}

export interface Loader {
  source: SourceId;
  /** One record at a time, so memory stays flat however large the subset. */
  records(): AsyncIterable<AuthorityRecord | LoadFailure>;
}

export const isFailure = (item: AuthorityRecord | LoadFailure): item is LoadFailure =>
  "failed" in item;

export const failure = (failed: string, err: unknown): LoadFailure => ({
  failed,
  reason: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
});
