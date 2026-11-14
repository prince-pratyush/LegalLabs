import { normalizeCitation } from "@legallabs/citations";
import { z } from "zod";
import { createHttp, type Http, NotFound } from "./http.js";
import type { AuthorityRecord } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { type Chunk, chunkText, htmlToText } from "./text.js";

const API = "https://www.courtlistener.com/api/rest/v4";

const searchResult = z.object({
  results: z.array(
    z.object({
      cluster_id: z.number().int(),
      caseName: z.string().min(1),
      court: z.string().min(1),
      court_id: z.string().min(1),
      dateFiled: z.string().nullish(),
      docketNumber: z.string().nullish(),
      citation: z.array(z.string()),
      absolute_url: z.string(),
      opinions: z.array(z.object({ id: z.number().int(), type: z.string().nullish() })),
    }),
  ),
});
type Cluster = z.infer<typeof searchResult>["results"][number];

const opinion = z.object({
  plain_text: z.string().nullish(),
  html_with_citations: z.string().nullish(),
  html: z.string().nullish(),
});

export interface CourtListenerOptions {
  cites: readonly string[];
  /** The deployment's own free API token; CourtListener refuses anonymous API calls. */
  token: string;
  http?: Http;
}

/** CourtListener's REST API, for opinions newer than the CAP snapshot. Needs a token. */
export function createCourtListenerLoader(options: CourtListenerOptions): Loader {
  // The free tier allows 5,000 requests an hour; one a second stays well inside it.
  const http =
    options.http ??
    createHttp({ perSecond: 1, headers: { authorization: `Token ${options.token}` } });
  return {
    source: "us_caselaw",
    async *records() {
      for (const cite of options.cites) {
        try {
          yield await fetchCluster(http, cite);
        } catch (err) {
          yield failure(cite, err);
        }
      }
    },
  };
}

async function fetchCluster(http: Http, cite: string): Promise<AuthorityRecord> {
  const wanted = normalizeCitation(cite);
  const query = new URLSearchParams({ type: "o", q: `citation:("${cite.replaceAll('"', "")}")` });
  const { results } = searchResult.parse(await http.json(`${API}/search/?${query}`));
  const found = results.find((r) => r.citation.some((c) => normalizeCitation(c) === wanted));
  if (!found) throw new NotFound(`no CourtListener cluster for ${cite}`);
  const chunks: Chunk[] = [];
  for (const entry of found.opinions) {
    const body = opinion.parse(await http.json(`${API}/opinions/${entry.id}/`));
    const text = body.plain_text?.trim() || htmlToText(body.html_with_citations ?? body.html ?? "");
    if (text) chunks.push(...chunkText(text, `Opinion (${entry.type ?? "unknown"})`));
  }
  return clusterRecord(found, chunks);
}

export function clusterRecord(found: Cluster, chunks: Chunk[]): AuthorityRecord {
  const [official, ...parallel] = found.citation;
  return {
    ref: `us_caselaw:cl:${found.cluster_id}`,
    title: found.caseName.slice(0, 1000),
    court: found.court.slice(0, 200),
    jurisdiction: "United States",
    docType: "opinion",
    ...(found.dateFiled && /^\d{4}-\d{2}-\d{2}$/.test(found.dateFiled)
      ? { decidedOn: found.dateFiled }
      : {}),
    url: `https://www.courtlistener.com${found.absolute_url}`,
    citations: [
      ...(official ? [{ text: official, kind: "reporter" as const }] : []),
      ...parallel.map((text) => ({ text, kind: "parallel" as const })),
      { text: found.caseName.slice(0, 500), kind: "alias" as const },
    ],
    sections: [],
    meta: {
      courtlistener_cluster_id: found.cluster_id,
      court_id: found.court_id,
      docket_number: found.docketNumber ?? null,
    },
    chunks: chunks.length > 0 ? chunks : [{ sectionPath: null, text: found.caseName }],
  };
}
