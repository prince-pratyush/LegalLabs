import { call, type HttpOptions, json, tokenRequest } from "./http.js";
import {
  type Download,
  ProviderError,
  type RemoteChange,
  type RemoteItem,
  type Scope,
  type SearchHit,
  type SyncProvider,
  type TokenSet,
} from "./types.js";

/**
 * Google Drive v3 (https://developers.google.com/drive/api/reference/rest/v3).
 * UNVERIFIED against a live account: written to the documentation, run against a mock only.
 */
export interface GoogleDriveOptions extends HttpOptions {
  clientId: string;
  clientSecret: string;
  /** Overridable so tests point at a mock server. */
  apiBase?: string;
  authBase?: string;
  tokenUrl?: string;
  now?: () => number;
}

const FOLDER = "application/vnd.google-apps.folder";
// Google-native files have no bytes; export them to the Office format the vault reads.
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
  },
};
const FIELDS = "id,name,mimeType,size,md5Checksum,version,modifiedTime,parents,trashed,webViewLink";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  version?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
}

const q = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export function toItem(f: DriveFile): RemoteItem {
  const folder = f.mimeType === FOLDER;
  return {
    id: f.id,
    name: f.name,
    parentIds: f.parents ?? [],
    kind: folder ? "folder" : "file",
    mime: f.mimeType,
    size: f.size ? Number(f.size) : null,
    // Binary files carry an md5; native Google files only a version counter.
    version: f.md5Checksum ?? `v${f.version ?? ""}:${f.modifiedTime ?? ""}`,
    webUrl: f.webViewLink ?? null,
    modifiedAt: f.modifiedTime ?? null,
  };
}

export function createGoogleDrive(options: GoogleDriveOptions): SyncProvider {
  const api = options.apiBase ?? "https://www.googleapis.com/drive/v3";
  const authBase = options.authBase ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = options.tokenUrl ?? "https://oauth2.googleapis.com/token";
  const now = options.now ?? Date.now;
  // Shared drives need these on every call; they are harmless for My Drive.
  const shared = "supportsAllDrives=true&includeItemsFromAllDrives=true";
  const tokens = (r: Awaited<ReturnType<typeof tokenRequest>>, prior = ""): TokenSet => ({
    accessToken: r.access_token,
    // Google only sends a refresh token on the first consent; keep the old one after that.
    refreshToken: r.refresh_token ?? prior,
    expiresAt: now() + r.expires_in * 1000,
  });

  async function listFiles(token: string, query: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let page = "";
    do {
      const res = await json<{ files: DriveFile[]; nextPageToken?: string }>(
        options,
        `${api}/files?q=${encodeURIComponent(query)}&pageSize=1000&fields=${encodeURIComponent(
          `nextPageToken,files(${FIELDS})`,
        )}&${shared}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
        token,
      );
      out.push(...res.files);
      page = res.nextPageToken ?? "";
    } while (page);
    return out;
  }

  return {
    id: "google_drive",
    authorizeUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return `${authBase}?${params}`;
    },
    async exchangeCode(code, redirectUri) {
      const r = await tokenRequest(options, tokenUrl, {
        code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const set = tokens(r);
      if (!set.refreshToken) throw new ProviderError("UPSTREAM", "No refresh token was granted.");
      const about = await json<{ user?: { emailAddress?: string } }>(
        options,
        `${api}/about?fields=user(emailAddress)`,
        set.accessToken,
      ).catch(() => ({}) as { user?: { emailAddress?: string } });
      return { ...set, accountLabel: about.user?.emailAddress ?? "" };
    },
    async refresh(refreshToken) {
      const r = await tokenRequest(options, tokenUrl, {
        refresh_token: refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
      });
      return tokens(r, refreshToken);
    },
    async browse(token, { folderId }) {
      const parent = folderId ?? "root";
      const files = await listFiles(token, `'${q(parent)}' in parents and trashed = false`);
      return files.map(toItem).sort((a, b) => a.name.localeCompare(b.name));
    },
    async search(token, _driveId, query) {
      const files = await listFiles(
        token,
        `fullText contains '${q(query)}' and trashed = false and mimeType != '${FOLDER}'`,
      );
      return files.slice(0, 25).map(
        (f): SearchHit => ({
          id: f.id,
          title: f.name,
          url: f.webViewLink ?? null,
          snippet: "",
          modified_at: f.modifiedTime ?? null,
        }),
      );
    },
    async getItem(token, _scope, id) {
      try {
        const f = await json<DriveFile>(
          options,
          `${api}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`,
          token,
        );
        return f.trashed ? null : toItem(f);
      } catch (err) {
        if (err instanceof ProviderError && err.code === "ACCESS_REVOKED" && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    async startToken(token) {
      const r = await json<{ startPageToken: string }>(
        options,
        `${api}/changes/startPageToken?supportsAllDrives=true`,
        token,
      );
      return r.startPageToken;
    },
    async listTree(token, scope) {
      const out: RemoteItem[] = [];
      const queue = [scope.rootId];
      const seen = new Set(queue);
      while (queue.length > 0) {
        const parent = queue.shift() as string;
        for (const f of await listFiles(token, `'${q(parent)}' in parents and trashed = false`)) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          const item = toItem(f);
          out.push(item);
          if (item.kind === "folder") queue.push(item.id);
        }
      }
      return out;
    },
    async changes(token, _scope, changeToken) {
      const changes: RemoteChange[] = [];
      let page = changeToken;
      for (;;) {
        const res = await json<{
          nextPageToken?: string;
          newStartPageToken?: string;
          changes: { fileId: string; removed?: boolean; file?: DriveFile }[];
        }>(
          options,
          `${api}/changes?pageToken=${encodeURIComponent(page)}&includeRemoved=true&pageSize=1000&fields=${encodeURIComponent(
            `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`,
          )}&${shared}`,
          token,
        );
        for (const c of res.changes) {
          if (c.removed || !c.file || c.file.trashed) changes.push({ id: c.fileId, removed: true });
          else changes.push({ id: c.fileId, removed: false, item: toItem(c.file) });
        }
        if (res.nextPageToken) {
          page = res.nextPageToken;
          continue;
        }
        return { changes, nextToken: res.newStartPageToken ?? page };
      }
    },
    async download(token, _scope, item): Promise<Download | null> {
      const exported = EXPORTS[item.mime];
      if (item.mime.startsWith("application/vnd.google-apps.") && !exported) return null;
      const url = exported
        ? `${api}/files/${encodeURIComponent(item.id)}/export?mimeType=${encodeURIComponent(exported.mime)}`
        : `${api}/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`;
      const res = await call(options, url, token);
      const name =
        exported && !item.name.toLowerCase().endsWith(exported.ext)
          ? `${item.name}${exported.ext}`
          : item.name;
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        name,
        mime: exported?.mime ?? item.mime,
      };
    },
  };
}
