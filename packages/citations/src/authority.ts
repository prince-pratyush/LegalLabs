import { type Located, locateQuote } from "./quote.js";

export type PassageLocated = Located & { passage: number };

export interface Authority {
  id: string;
  pages?: { first: number; last: number };
  sections?: readonly string[];
}

export interface AuthorityCitation {
  kind: "authority";
  reference: string;
  pin?: string;
  quote?: string;
}

export interface AuthoritySources {
  authorityById(id: string): Promise<Authority | null>;
  authoritiesByCitation(normalized: string): Promise<readonly Authority[]>;
  authorityPassages(id: string): Promise<readonly string[]>;
}

export type AuthorityVerification =
  | { status: "ok"; authorityId: string; located?: PassageLocated }
  | {
      status: "mismatch";
      reason: "pin_not_found" | "quote_not_found" | "quote_too_short";
      authorityId: string;
    }
  | { status: "mismatch"; reason: "meaning_changed"; authorityId: string; closest: PassageLocated }
  | { status: "unresolved"; reason: "authority_not_found" }
  | { status: "unresolved"; reason: "ambiguous_authority"; candidates: readonly string[] };

const INDEX_ID = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:[^\s:]+$/;

const REPORTERS: readonly [RegExp, string][] = [
  [/\bf supp (2d|3d)\b/g, "fsupp$1"],
  [/\bf supp\b/g, "fsupp"],
  [/\bf (2d|3d|4th)\b/g, "f$1"],
  [/\bl ed 2d\b/g, "led2d"],
  [/\bl ed\b/g, "led"],
  [/\bs ct\b/g, "sct"],
  [/\bu s\b/g, "us"],
];

const REPORTER_CITE = /^\d+ (?:us|f|f2d|f3d|f4th|fsupp|fsupp2d|fsupp3d|sct|led|led2d) \d+/;

// Identifiers with a fixed shape are matched whole, before the general rules below.
const IDENTIFIERS: readonly [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(?:celex:?\s*)?([0-9ce][0-9]{4}[a-z]{1,2}[0-9]{4}(?:\([0-9]+\))?)$/i, (m) => `celex ${m[1]}`],
  [
    /^ecli:([a-z]{2}):([a-z0-9]{1,7}):([0-9]{4}):([a-z0-9.]{1,25})$/i,
    (m) => `ecli:${m[1]}:${m[2]}:${m[3]}:${m[4]}`,
  ],
  [
    /^(?:accession(?: no\.?| number)?:?\s*)?([0-9]{10})-?([0-9]{2})-?([0-9]{6})$/i,
    (m) => `accession ${m[1]}-${m[2]}-${m[3]}`,
  ],
  // Federal Register document numbers, as "FR Doc. 2020-17747" or "FR Doc. No. 2020-17747".
  [
    /^fr doc(?:ument)?\.?(?:\s*(?:no|number)\.?)?:?\s*([a-z0-9]{1,4}(?:-\d{1,6}){1,2})$/i,
    (m) => `fr doc ${m[1]}`,
  ],
  // Regulation (EU) 2016/679, Regulation (EU) No 2016/679, Directive 95/46/EC.
  [
    /^(regulation|directive|decision)\s*\((eu|ec|eec|euratom)\)\s*(?:no\.?\s*)?([0-9]{2,4}\/[0-9]{1,4})$/i,
    (m) => `${m[1]} (${m[2]}) ${m[3]}`,
  ],
  [
    /^(regulation|directive|decision)\s*(?:no\.?\s*)?([0-9]{2,4}\/[0-9]{1,4})\/(eu|ec|eec|euratom)$/i,
    (m) => `${m[1]} (${m[3]}) ${m[2]}`,
  ],
];

/** The one normalisation used to write and to read the citation index. */
export function normalizeCitation(reference: string): string {
  const compact = reference.normalize("NFKC").replace(/\s+/g, " ").trim();
  for (const [form, canonical] of IDENTIFIERS) {
    const match = form.exec(compact);
    if (match) return canonical(match).toLowerCase();
  }
  let text = compact
    .toLowerCase()
    .replace(/\b(?:sections?|secs?)\b\.?/g, "§")
    .replace(/§\s*/g, "§ ")
    // Periods go, except inside numbers like 240.10b-5.
    .replace(/(?<!\d)\.|\.(?!\d)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [form, canonical] of REPORTERS) text = text.replace(form, canonical);
  // 85 Fed. Reg. 58,029 (Sept. 17, 2020) is 85 FR 58029.
  text = text.replace(
    /^(\d+) (?:fed ?reg|fr) (\d{1,3}(?:,\d{3})+|\d+)(?: \([^)]*\))?$/,
    (_, volume: string, page: string) => `${volume} fr ${page.replaceAll(",", "")}`,
  );
  // 17 CFR 240.10b-5 and 17 C.F.R. § 240.10b-5 (2024) are one section.
  text = text.replace(
    /^(\d+) (?:cfr|code of federal regulations),? (?:§ )*(\d+[a-z]?\.\d\S*)(?: \((?:19|20)\d{2}\))?$/,
    "$1 cfr § $2",
  );
  // Parentheticals carry court and year only on reporter cites; on statutes the year matters.
  if (REPORTER_CITE.test(text)) {
    text = text.replace(/\s*\([^)]*\)/g, "").replace(/^(\d+ \w+ \d+),? (?:19|20)\d{2}$/, "$1");
  }
  return text;
}

// "17 cfr § 240.10b-5(b)" names paragraph (b) of a section the index holds whole.
const PART_OF: readonly RegExp[] = [
  /^\d+ cfr (§ [^\s(]+(?:\([^)]*\)-[^\s(]+)?)((?:\([0-9a-z]+\))+)$/,
];

function splitPin(normalized: string): { whole: string; pin: string } | null {
  for (const form of PART_OF) {
    const match = form.exec(normalized);
    if (!match) continue;
    const [, section = "", part = ""] = match;
    return { whole: normalized.slice(0, -part.length), pin: `${section}${part}` };
  }
  return null;
}

/** The authorities a reference names, and the pin written inside it, if it had to be set aside. */
async function findAuthorities(
  reference: string,
  sources: AuthoritySources,
): Promise<{ found: readonly Authority[]; pin?: string }> {
  if (INDEX_ID.test(reference)) {
    const authority = await sources.authorityById(reference);
    return { found: authority === null ? [] : [authority] };
  }
  const normalized = normalizeCitation(reference);
  const found = await sources.authoritiesByCitation(normalized);
  const split = found.length === 0 ? splitPin(normalized) : null;
  if (!split) return { found };
  return { found: await sources.authoritiesByCitation(split.whole), pin: split.pin };
}

export async function verifyAuthority(
  citation: AuthorityCitation,
  sources: AuthoritySources,
): Promise<AuthorityVerification> {
  const { found, pin } = await findAuthorities(citation.reference, sources);
  const candidates = [...new Map(found.map((entry) => [entry.id, entry])).values()];
  const [authority, ...others] = candidates;
  if (authority === undefined) return { status: "unresolved", reason: "authority_not_found" };
  if (others.length > 0) {
    return {
      status: "unresolved",
      reason: "ambiguous_authority",
      candidates: candidates.map((candidate) => candidate.id),
    };
  }
  const pins = [pin, citation.pin].filter((p) => p !== undefined);
  if (!pins.every((p) => pinExists(p, authority))) {
    return { status: "mismatch", reason: "pin_not_found", authorityId: authority.id };
  }
  if (citation.quote === undefined) return { status: "ok", authorityId: authority.id };
  return quoteInPassages(
    citation.quote,
    authority.id,
    await sources.authorityPassages(authority.id),
  );
}

function quoteInPassages(
  quote: string,
  authorityId: string,
  passages: readonly string[],
): AuthorityVerification {
  let refused: PassageLocated | null = null;
  for (const [passage, text] of passages.entries()) {
    const result = locateQuote(text, quote);
    if (result.status === "ok") {
      return { status: "ok", authorityId, located: { ...result.located, passage } };
    }
    if (result.reason === "quote_too_short") return { ...result, authorityId };
    if (result.reason === "meaning_changed") refused ??= { ...result.closest, passage };
  }
  return refused === null
    ? { status: "mismatch", reason: "quote_not_found", authorityId }
    : { status: "mismatch", reason: "meaning_changed", authorityId, closest: refused };
}

/**
 * Only a citation that reached a stored authority gets a link: ok, or a flagged mismatch the
 * reader can check against the source. Unresolved and ambiguous ones stay plain text.
 */
export function authorityHref(result: AuthorityVerification): string | null {
  if (result.status === "unresolved") return null;
  return `/knowledge/authorities/${encodeURIComponent(result.authorityId)}`;
}

// A pin we cannot confirm is flagged, including forms the grammar does not read yet.
function pinExists(pin: string, authority: Authority): boolean {
  const normalized = normalizeCitation(pin).replace(/^art /, "article ");
  // Named parts such as "Article 6" or "Item 1A" match the authority's own section names.
  if (authority.sections?.some((s) => normalizeCitation(s) === normalized)) return true;
  if (normalized.startsWith("§")) {
    return authority.sections?.some((s) => normalizeCitation(s) === normalized) ?? false;
  }
  const page = /^(?:at |pp? ?)?(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(normalized);
  if (page === null || authority.pages === undefined) return false;
  const start = page[1] as string;
  const end = page[2] ?? start;
  // Short ranges drop leading digits: 120-25 means 120 to 125.
  const last = Number(start.slice(0, Math.max(0, start.length - end.length)) + end);
  const first = Number(start);
  return first <= last && first >= authority.pages.first && last <= authority.pages.last;
}
