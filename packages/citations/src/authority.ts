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

function normalizeCitation(reference: string): string {
  let text = reference
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:sections?|secs?)\b\.?/g, "§")
    .replace(/§\s*/g, "§ ")
    // Periods go, except inside numbers like 240.10b-5.
    .replace(/(?<!\d)\.|\.(?!\d)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [form, canonical] of REPORTERS) text = text.replace(form, canonical);
  // Parentheticals carry court and year only on reporter cites; on statutes the year matters.
  if (REPORTER_CITE.test(text)) {
    text = text.replace(/\s*\([^)]*\)/g, "").replace(/^(\d+ \w+ \d+),? (?:19|20)\d{2}$/, "$1");
  }
  return text;
}

async function findAuthorities(
  reference: string,
  sources: AuthoritySources,
): Promise<readonly Authority[]> {
  if (!INDEX_ID.test(reference)) return sources.authoritiesByCitation(normalizeCitation(reference));
  const authority = await sources.authorityById(reference);
  return authority === null ? [] : [authority];
}

export async function verifyAuthority(
  citation: AuthorityCitation,
  sources: AuthoritySources,
): Promise<AuthorityVerification> {
  const found = await findAuthorities(citation.reference, sources);
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
  if (citation.pin !== undefined && !pinExists(citation.pin, authority)) {
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

// A pin we cannot confirm is flagged, including forms the grammar does not read yet.
function pinExists(pin: string, authority: Authority): boolean {
  const normalized = normalizeCitation(pin);
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
