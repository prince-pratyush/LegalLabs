import { z } from "zod";
import { CFR_SECTION } from "./ecfr.js";
import { FR_DOCUMENT_NUMBER } from "./fr.js";
import { createHttp, type Http } from "./http.js";
import { clean } from "./text.js";
import { UK_INSTRUMENTS, UK_TYPES, ukHttp } from "./uk.js";
import { childElements, parseXml } from "./xml.js";

// What is new at a source since a cursor. A request carries only a date and a page, never
// anything a person typed. Every address kept is built here or checked against the source's host.

/** `page` and `after` mark how far into the results since `since` the last call got. */
export const scanCursor = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  page: z.number().int().min(2).max(100).optional(),
  after: z.string().max(200).optional(),
});
export type ScanCursor = z.infer<typeof scanCursor>;

export interface ScanCandidate {
  /** The source's own name for it, checked, so its text can be fetched later. */
  externalId: string;
  url: string;
  title: string;
  summary: string;
  docType: string;
  publishedOn: string;
}

export interface ScanResult {
  items: ScanCandidate[];
  cursor: ScanCursor;
}

export const SCAN_SOURCE_IDS = ["fr", "ecfr", "uk_legislation"] as const;
export type ScanSourceId = (typeof SCAN_SOURCE_IDS)[number];
export type Scanners = Record<ScanSourceId, (cursor: ScanCursor) => Promise<ScanResult>>;

/** One answer's worth. */
const PAGE = 100;
const ECFR_TITLES = 50;
const UK_PAGES = 15;

const line = (raw: string, cap: number) => clean(raw).replace(/\s+/g, " ").trim().slice(0, cap);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const FR_HOST = "www.federalregister.gov";
const FR_TYPES: Record<string, string> = {
  Rule: "rule",
  "Proposed Rule": "proposed_rule",
  Notice: "notice",
  "Presidential Document": "presidential_document",
};
const frPage = z.object({
  count: z.number().optional(),
  total_pages: z.number().optional(),
  results: z.array(z.unknown()).optional(),
});
const frEntry = z.object({
  document_number: z.string().regex(FR_DOCUMENT_NUMBER),
  title: z.string().min(1),
  type: z.string(),
  abstract: z.string().nullish(),
  publication_date: day,
  html_url: z.string().nullish(),
});

function onFederalRegister(raw: string | null | undefined): string | null {
  const url = raw && URL.canParse(raw) ? new URL(raw) : null;
  return url && url.protocol === "https:" && url.host === FR_HOST && !url.username
    ? url.href.slice(0, 2000)
    : null;
}

async function scanFederalRegister(http: Http, cursor: ScanCursor): Promise<ScanResult> {
  const page = cursor.page ?? 1;
  const query = new URLSearchParams({
    "conditions[publication_date][gte]": cursor.since,
    order: "oldest",
    per_page: String(PAGE),
    page: String(page),
  });
  for (const field of Object.keys(frEntry.shape)) query.append("fields[]", field);
  const answer = frPage.parse(await http.json(`https://${FR_HOST}/api/v1/documents.json?${query}`));
  const items: ScanCandidate[] = [];
  for (const raw of (answer.results ?? []).slice(0, PAGE)) {
    const entry = frEntry.safeParse(raw).data;
    if (!entry) continue;
    items.push({
      externalId: entry.document_number,
      url: onFederalRegister(entry.html_url) ?? `https://${FR_HOST}/d/${entry.document_number}`,
      title: line(entry.title, 1000),
      summary: line(entry.abstract ?? "", 4000),
      docType: FR_TYPES[entry.type] ?? "other",
      publishedOn: entry.publication_date,
    });
  }
  const newest = items.reduce((last, i) => (i.publishedOn > last ? i.publishedOn : last), "");
  const more = page < (answer.total_pages ?? 1) && page < 100;
  return {
    items,
    cursor: more
      ? { since: cursor.since, page: page + 1 }
      : { since: newest > cursor.since ? newest : cursor.since },
  };
}

/**
 * For sources that list everything since a date: the next hundred in a fixed order. The cursor
 * only moves its date on once the whole list has been taken.
 */
function take(found: (ScanCandidate & { key: string })[], cursor: ScanCursor): ScanResult {
  const left = found
    .filter((c) => cursor.after === undefined || c.key > cursor.after)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken = left.slice(0, PAGE);
  const newest = found.reduce((last, i) => (i.publishedOn > last ? i.publishedOn : last), "");
  const after = taken.at(-1)?.key;
  return {
    items: taken.map(({ key: _key, ...candidate }) => candidate),
    cursor:
      left.length > taken.length && after
        ? { since: cursor.since, after }
        : { since: newest > cursor.since ? newest : cursor.since },
  };
}

const ECFR_API = "https://www.ecfr.gov/api/versioner/v1";
const ECFR_HEADERS = { "accept-encoding": "gzip, deflate" };
const ecfrTitles = z.object({
  titles: z.array(z.object({ number: z.number().int(), latest_amended_on: day.nullish() })),
});
const ecfrVersions = z.object({ content_versions: z.array(z.unknown()) });
const ecfrVersion = z.object({
  identifier: z.string().regex(CFR_SECTION),
  name: z.string(),
  type: z.literal("section"),
  issue_date: day,
  substantive: z.boolean().optional(),
  removed: z.boolean().optional(),
});

async function scanEcfr(http: Http, cursor: ScanCursor): Promise<ScanResult> {
  const { titles } = ecfrTitles.parse(await http.json(`${ECFR_API}/titles.json`, ECFR_HEADERS));
  const changed = titles
    .filter((t) => t.number > 0 && t.number < 100 && (t.latest_amended_on ?? "") >= cursor.since)
    .slice(0, ECFR_TITLES);
  const found = new Map<string, ScanCandidate & { key: string }>();
  for (const { number } of changed) {
    const query = new URLSearchParams({ "issue_date[gte]": cursor.since });
    const answer = ecfrVersions.parse(
      await http.json(`${ECFR_API}/versions/title-${number}.json?${query}`, ECFR_HEADERS),
    );
    for (const raw of answer.content_versions) {
      const version = ecfrVersion.safeParse(raw).data;
      if (!version || version.substantive === false || version.issue_date < cursor.since) continue;
      const { identifier, issue_date: issued } = version;
      const key = `${issued}|${String(number).padStart(2, "0")}|${identifier}`;
      found.set(key, {
        key,
        externalId: `${number}/${identifier}@${issued}`,
        url: `https://www.ecfr.gov/on/${issued}/title-${number}/section-${encodeURIComponent(identifier)}`,
        title: line(`${number} CFR ${version.name}`, 1000),
        summary: version.removed
          ? "Section removed from the Code of Federal Regulations."
          : "Section amended.",
        docType: "regulation",
        publishedOn: issued,
      });
    }
  }
  return take([...found.values()], cursor);
}

const UK_SITE = "https://www.legislation.gov.uk";
const UK_ID = /^https?:\/\/www\.legislation\.gov\.uk\/id\/([a-z]{2,6})\/(\d{4})\/(\d{1,6})$/;

async function scanUk(http: Http, cursor: ScanCursor): Promise<ScanResult> {
  const found = new Map<string, ScanCandidate & { key: string }>();
  for (let page = 1; page <= UK_PAGES; page++) {
    // The page number is ours: the feed's own "next" address is never followed.
    const root = parseXml(
      await http.text(`${UK_SITE}/new/data.feed?page=${page}`, { accept: "application/atom+xml" }),
    );
    if (root.localName !== "feed") throw new Error("not a feed");
    const children = childElements(root);
    let older = false;
    for (const element of children.filter((e) => e.localName === "entry")) {
      const text = (name: string) =>
        childElements(element)
          .find((e) => e.localName === name)
          ?.textContent?.trim() ?? "";
      const published = (text("published") || text("updated")).slice(0, 10);
      if (!day.safeParse(published).success) continue;
      if (published < cursor.since) {
        older = true;
        continue;
      }
      const [, type = "", year, number] = UK_ID.exec(text("id")) ?? [];
      const title = line(text("title"), 1000);
      if (!(UK_TYPES as readonly string[]).includes(type) || !title) continue;
      const externalId = `${type}/${year}/${Number(number)}`;
      const key = `${published}|${externalId}`;
      found.set(externalId, {
        key,
        externalId,
        url: `${UK_SITE}/${externalId}`,
        title,
        summary: line(text("summary"), 4000),
        docType: (UK_INSTRUMENTS as readonly string[]).includes(type)
          ? "statutory_instrument"
          : "act",
        publishedOn: published,
      });
    }
    const next = children.some((e) => e.localName === "link" && e.getAttribute("rel") === "next");
    // The feed is newest first, so the first older entry ends it.
    if (older || !next) break;
  }
  return take([...found.values()], cursor);
}

export interface ScannerOptions {
  userAgent?: string | undefined;
  /** For tests; one client per source otherwise. */
  http?: (source: ScanSourceId) => Http;
}

export function createScanners(options: ScannerOptions = {}): Scanners {
  const { userAgent } = options;
  const client = (source: ScanSourceId) =>
    options.http?.(source) ??
    (source === "uk_legislation"
      ? ukHttp(userAgent)
      : createHttp({ perSecond: source === "fr" ? 2 : 1, userAgent, timeoutMs: 30_000 }));
  const fr = client("fr");
  const ecfr = client("ecfr");
  const uk = client("uk_legislation");
  return {
    fr: (cursor) => scanFederalRegister(fr, cursor),
    ecfr: (cursor) => scanEcfr(ecfr, cursor),
    uk_legislation: (cursor) => scanUk(uk, cursor),
  };
}
