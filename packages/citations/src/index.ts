export type {
  Authority,
  AuthorityCitation,
  AuthoritySources,
  AuthorityVerification,
  PassageLocated,
} from "./authority.js";
export { authorityHref, normalizeCitation } from "./authority.js";
export type { CitedAnswer, ParsedCitation } from "./parse.js";
export { parseCitedAnswer } from "./parse.js";
export type { Located } from "./quote.js";
export type { Citation, CitationStatus, Sources, Verification } from "./verify.js";
export { verifyCitation } from "./verify.js";
