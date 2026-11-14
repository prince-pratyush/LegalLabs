import { createHash } from "node:crypto";
import { z } from "zod";

export const SOURCE_ID = /^[a-z][a-z0-9_]{0,39}$/;
export const AUTHORITY_REF = /^[a-z][a-z0-9_]{0,39}:[a-z][a-z0-9_]{0,19}:[^\s:]{1,200}$/;

export const citationKinds = [
  "reporter",
  "parallel",
  "neutral",
  "docket",
  "celex",
  "ecli",
  "act",
  "alias",
  "accession",
] as const;
export type CitationKind = (typeof citationKinds)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().min(1).max(max);

/**
 * One public-law document as every loader hands it over: the shape the bulk
 * files use too, so an air-gapped load and a live sync share one writer.
 */
export const authorityRecord = z.object({
  ref: z.string().regex(AUTHORITY_REF),
  title: text(1000),
  court: text(200).optional(),
  jurisdiction: text(50).optional(),
  docType: text(50).optional(),
  decidedOn: isoDate.optional(),
  url: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .optional(),
  citations: z.array(z.object({ text: text(500), kind: z.enum(citationKinds) })).max(100),
  firstPage: z.number().int().min(1).optional(),
  lastPage: z.number().int().min(1).optional(),
  sections: z.array(text(500)).max(5000),
  meta: z.record(z.string(), z.unknown()),
  chunks: z.array(z.object({ sectionPath: text(500).nullable(), text: text(20000) })).min(1),
});
export type AuthorityRecord = z.infer<typeof authorityRecord>;

export const sourceOf = (ref: string) => ref.slice(0, ref.indexOf(":"));

/** Changes whenever anything a reader could see changes, and only then. */
export function contentHash(record: AuthorityRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
