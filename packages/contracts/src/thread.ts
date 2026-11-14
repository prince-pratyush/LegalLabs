import { z } from "zod";
import { Id } from "./id.js";

// Limits from the PRD, kept here so the API, the web app and siblings agree.
export const LIMITS = {
  uploads: 50,
  vaults: 2,
  sources: 5,
  promptChars: 100_000,
  draftsPerThread: 20,
} as const;

export const SourceSelection = z.object({
  source_id: z.string().min(1).max(100),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export type SourceSelection = z.infer<typeof SourceSelection>;

/** What a turn may read: files, vaults and public-law sources. */
export const ThreadScope = z.object({
  document_ids: z.array(Id).max(LIMITS.uploads).default([]),
  vault_ids: z.array(Id).max(LIMITS.vaults).default([]),
  sources: z.array(SourceSelection).max(LIMITS.sources).default([]),
});
export type ThreadScope = z.infer<typeof ThreadScope>;

export const MentionType = z.enum(["document", "vault", "source"]);
export type MentionType = z.infer<typeof MentionType>;

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("mention"),
    ref_type: MentionType,
    ref_id: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const ResponseMode = z.enum(["auto", "edit", "answer"]);
export type ResponseMode = z.infer<typeof ResponseMode>;

// The viewer's deep link (document-viewer.md 4.4); the version is pinned so a
// later upload never moves the highlight.
export const CitationTarget = z.object({
  document_id: Id,
  version_no: z.number().int().min(1),
  page: z.number().int().min(1),
  char_from: z.number().int().min(0).optional(),
  char_to: z.number().int().min(0).optional(),
});
export type CitationTarget = z.infer<typeof CitationTarget>;

export function citationPath(target: CitationTarget): string {
  const query = new URLSearchParams({ p: String(target.page) });
  if (target.char_from !== undefined && target.char_to !== undefined) {
    query.set("cf", String(target.char_from));
    query.set("ct", String(target.char_to));
  }
  return `/d/${target.document_id}/v/${target.version_no}?${query}`;
}

/** Null for anything that isn't a well-formed deep link. */
export function parseCitationPath(path: string): CitationTarget | null {
  const url = new URL(path, "http://x");
  const match = /^\/d\/([^/]+)\/v\/(\d+)$/.exec(url.pathname);
  if (!match) return null;
  const number = (key: string) => {
    const value = url.searchParams.get(key);
    return value === null ? undefined : Number(value);
  };
  const parsed = CitationTarget.safeParse({
    document_id: match[1],
    version_no: Number(match[2]),
    page: number("p"),
    char_from: number("cf"),
    char_to: number("ct"),
  });
  return parsed.success ? parsed.data : null;
}

// Sibling ports. Threads calls these; the vault and knowledge work implements them.
export interface Caller {
  workspaceId: string;
  userId: string;
}

export interface VaultSummary {
  id: string;
  name: string;
  file_count: number;
}

export interface VaultPort {
  list(caller: Caller): Promise<VaultSummary[]>;
  /** Documents in these vaults the caller can read, walls applied. */
  documentIds(caller: Caller, vaultIds: readonly string[], limit: number): Promise<string[]>;
}

export interface SourceSummary {
  id: string;
  name: string;
  kind: string;
  jurisdiction?: string;
}

export interface AuthorityPassage {
  authority_id: string;
  source_id: string;
  citation_string: string;
  title: string;
  url: string;
  pin?: string;
  text: string;
}

export interface KnowledgePort {
  list(caller: Caller): Promise<SourceSummary[]>;
  search(
    caller: Caller,
    sources: readonly SourceSelection[],
    query: string,
    limit: number,
  ): Promise<AuthorityPassage[]>;
}
