import { normalizeCitation } from "@legallabs/citations";
import { z } from "zod";
import { createHttp, type Http, NotFound } from "./http.js";
import type { AuthorityRecord, CitationKind } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { type Chunk, chunkText } from "./text.js";

const BASE = "https://static.case.law";

// Normalised reporter token to the Caselaw Access Project's reporter slug.
const REPORTERS: Record<string, string> = {
  us: "us",
  sct: "s-ct",
  led: "l-ed",
  led2d: "l-ed-2d",
  f: "f",
  f2d: "f2d",
  f3d: "f3d",
  fsupp: "f-supp",
  fsupp2d: "f-supp-2d",
  fsupp3d: "f-supp-3d",
};

const capCase = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  name_abbreviation: z.string().min(1),
  decision_date: z.string(),
  docket_number: z.string().nullish(),
  first_page: z.string(),
  last_page: z.string(),
  citations: z.array(z.object({ type: z.string(), cite: z.string().min(1) })),
  court: z.object({ name: z.string().min(1) }),
  jurisdiction: z.object({ name_long: z.string().min(1) }).nullish(),
  cites_to: z.array(z.object({ cite: z.string() })).nullish(),
  casebody: z.object({
    head_matter: z.string().nullish(),
    opinions: z.array(
      z.object({ type: z.string(), author: z.string().nullish(), text: z.string() }),
    ),
  }),
});
type CapCase = z.infer<typeof capCase>;

/** "556 U.S. 662" to the reporter slug, volume and page CAP files it under. */
export function capLocation(
  cite: string,
): { reporter: string; volume: number; page: number } | null {
  const match = /^(\d{1,4}) ([a-z0-9]+) (\d{1,5})$/.exec(normalizeCitation(cite));
  const reporter = match ? REPORTERS[match[2] ?? ""] : undefined;
  if (!match || reporter === undefined) return null;
  return { reporter, volume: Number(match[1]), page: Number(match[3]) };
}

const KINDS: Record<string, CitationKind> = { official: "reporter", parallel: "parallel" };

const page = (value: string) => (/^\d+$/.test(value) ? Number(value) : undefined);

export function capRecord(found: CapCase, url: string): AuthorityRecord {
  const chunks: Chunk[] = [];
  if (found.casebody.head_matter) chunks.push(...chunkText(found.casebody.head_matter, "Syllabus"));
  for (const opinion of found.casebody.opinions) {
    const by = opinion.author ? `, ${opinion.author.replace(/[,.]+$/, "")}` : "";
    chunks.push(...chunkText(opinion.text, `Opinion (${opinion.type}${by})`));
  }
  const first = page(found.first_page);
  const last = page(found.last_page);
  const citations = found.citations.flatMap((c) => {
    const kind = KINDS[c.type];
    return kind === undefined ? [] : [{ text: c.cite, kind }];
  });
  citations.push({ text: found.name_abbreviation.slice(0, 500), kind: "alias" });
  return {
    ref: `us_caselaw:cap:${found.id}`,
    title: found.name_abbreviation.slice(0, 1000),
    court: found.court.name.slice(0, 200),
    ...(found.jurisdiction ? { jurisdiction: found.jurisdiction.name_long.slice(0, 50) } : {}),
    docType: "opinion",
    // Partial dates stay in meta rather than being padded into a day that never was.
    ...(/^\d{4}-\d{2}-\d{2}$/.test(found.decision_date) ? { decidedOn: found.decision_date } : {}),
    url,
    citations,
    ...(first === undefined ? {} : { firstPage: first }),
    ...(first !== undefined && last !== undefined && last >= first ? { lastPage: last } : {}),
    sections: [],
    meta: {
      cap_id: found.id,
      full_name: found.name,
      decision_date: found.decision_date,
      docket_number: found.docket_number ?? null,
      cites_to: (found.cites_to ?? []).slice(0, 200).map((c) => c.cite),
      licence: "CC0-1.0",
    },
    chunks: chunks.length > 0 ? chunks : [{ sectionPath: null, text: found.name }],
  };
}

export interface CapOptions {
  /** Reporter citations to load, such as "556 U.S. 662". */
  cites: readonly string[];
  http?: Http;
}

/** Caselaw Access Project static files: public domain, no key, one file per case. */
export function createCapLoader(options: CapOptions): Loader {
  // Static files on a CDN; a modest pace is still the polite one.
  const http = options.http ?? createHttp({ perSecond: 2 });
  return {
    source: "us_caselaw",
    async *records() {
      for (const cite of options.cites) {
        const where = capLocation(cite);
        if (where === null) {
          yield { failed: cite, reason: "not a reporter citation CAP files" };
          continue;
        }
        try {
          yield await fetchCase(http, cite, where);
        } catch (err) {
          yield failure(cite, err);
        }
      }
    },
  };
}

async function fetchCase(
  http: Http,
  cite: string,
  where: { reporter: string; volume: number; page: number },
): Promise<AuthorityRecord> {
  const wanted = normalizeCitation(cite);
  const folder = `${BASE}/${where.reporter}/${where.volume}`;
  // Several short cases can start on one page; the one carrying the citation is the one.
  for (let order = 1; order <= 5; order++) {
    const file = `${String(where.page).padStart(4, "0")}-${String(order).padStart(2, "0")}`;
    let raw: unknown;
    try {
      raw = await http.json(`${folder}/cases/${file}.json`);
    } catch (err) {
      if (err instanceof NotFound) break;
      throw err;
    }
    const found = capCase.parse(raw);
    if (found.citations.some((c) => normalizeCitation(c.cite) === wanted)) {
      return capRecord(found, `${folder}/cases/${file}.json`);
    }
  }
  throw new NotFound(`no CAP case for ${cite}`);
}
