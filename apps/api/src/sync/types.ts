/**
 * The seam between the sync engine and a cloud drive. Everything here is written to the
 * vendors' public API documents (Google Drive v3, Microsoft Graph v1.0) and has only been run
 * against mock servers: live-account behaviour is UNVERIFIED.
 */
export type SyncProviderId = "google_drive" | "sharepoint";

export interface RemoteItem {
  id: string;
  name: string;
  /** Drive allows several parents; Graph has one. The engine takes the first one in the tree. */
  parentIds: string[];
  kind: "folder" | "file";
  mime: string;
  size: number | null;
  /** Changes only when the content does: Drive md5 / native version, Graph cTag. */
  version: string;
  webUrl: string | null;
  modifiedAt: string | null;
}

export type RemoteChange =
  | { id: string; removed: true }
  | { id: string; removed: false; item: RemoteItem };

/** Where a sync starts: a drive (null = the person's own) and the folder it mirrors. */
export interface Scope {
  driveId: string | null;
  rootId: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type ProviderErrorCode =
  /** 401: the access token ran out; refresh and retry once. */
  | "TOKEN_EXPIRED"
  /** The refresh token was refused: the person must connect again. */
  | "AUTH_REVOKED"
  /** 403/404 on the synced folder: permission was removed or the folder is gone. */
  | "ACCESS_REVOKED"
  /** 410: the change token is too old; list the whole folder again. */
  | "CHANGE_TOKEN_INVALID"
  | "RATE_LIMITED"
  | "UPSTREAM";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status = 0,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Download {
  bytes: Uint8Array;
  /** The file name to store: Google-native files gain .docx/.xlsx/.pptx. */
  name: string;
  mime: string;
}

export interface SearchHit {
  id: string;
  title: string;
  url: string | null;
  snippet: string;
  modified_at: string | null;
}

export interface SyncProvider {
  readonly id: SyncProviderId;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet & { accountLabel: string }>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** One level of a folder; null folder = the drive's top. Backs the picker. */
  browse(
    token: string,
    scope: { driveId: string | null; folderId: string | null },
  ): Promise<RemoteItem[]>;
  search(token: string, driveId: string | null, query: string): Promise<SearchHit[]>;
  getItem(token: string, scope: Scope, id: string): Promise<RemoteItem | null>;
  /** The change token to store; taken before the listing so nothing slips between them. */
  startToken(token: string, scope: Scope): Promise<string>;
  /** Everything under the root, folders before their children. */
  listTree(token: string, scope: Scope): Promise<RemoteItem[]>;
  /** Changes since `changeToken`, whole drive (the engine drops what is outside the tree). */
  changes(
    token: string,
    scope: Scope,
    changeToken: string,
  ): Promise<{ changes: RemoteChange[]; nextToken: string }>;
  download(token: string, scope: Scope, item: RemoteItem): Promise<Download | null>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
