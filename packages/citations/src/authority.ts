export interface Authority {
  id: string;
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
  | { status: "ok"; authorityId: string }
  | { status: "unresolved"; reason: "authority_not_found" }
  | { status: "unresolved"; reason: "ambiguous_authority"; candidates: readonly string[] };

const INDEX_ID = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:[^\s:]+$/;

async function findAuthorities(
  reference: string,
  sources: AuthoritySources,
): Promise<readonly Authority[]> {
  if (!INDEX_ID.test(reference)) return sources.authoritiesByCitation(reference);
  const authority = await sources.authorityById(reference);
  return authority === null ? [] : [authority];
}

export async function verifyAuthority(
  citation: AuthorityCitation,
  sources: AuthoritySources,
): Promise<AuthorityVerification> {
  const candidates = await findAuthorities(citation.reference, sources);
  const [authority, ...others] = candidates;
  if (authority === undefined) return { status: "unresolved", reason: "authority_not_found" };
  if (others.length > 0) {
    return {
      status: "unresolved",
      reason: "ambiguous_authority",
      candidates: candidates.map((candidate) => candidate.id),
    };
  }
  return { status: "ok", authorityId: authority.id };
}
