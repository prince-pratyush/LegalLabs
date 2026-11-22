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
 * SharePoint and OneDrive through Microsoft Graph v1.0
 * (https://learn.microsoft.com/graph/api/driveitem-delta). Delta on a SharePoint or OneDrive
 * for Business drive works on the drive root only, so a folder sync takes the root's delta and
 * the engine drops what lies outside the chosen folder.
 * UNVERIFIED against a live tenant: written to the documentation, run against a mock only.
 */
export interface SharePointOptions extends HttpOptions {
  clientId: string;
  clientSecret: string;
  tenant?: string;
  graphBase?: string;
  authBase?: string;
  now?: () => number;
}

interface GraphItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  cTag?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: { id?: string };
  folder?: object;
  file?: { mimeType?: string };
  deleted?: { state?: string };
  root?: object;
}

const SCOPES = "offline_access Files.Read.All Sites.Read.All";

export function toItem(g: GraphItem): RemoteItem {
  return {
    id: g.id,
    name: g.name ?? "",
    parentIds: g.parentReference?.id ? [g.parentReference.id] : [],
    kind: g.folder ? "folder" : "file",
    mime: g.file?.mimeType ?? "",
    size: g.size ?? null,
    // cTag moves with content only; eTag also moves on a rename or a permission change.
    version: g.cTag ?? g.eTag ?? "",
    webUrl: g.webUrl ?? null,
    modifiedAt: g.lastModifiedDateTime ?? null,
  };
}

export function createSharePoint(options: SharePointOptions): SyncProvider {
  const graph = options.graphBase ?? "https://graph.microsoft.com/v1.0";
  const tenant = options.tenant ?? "common";
  const authBase = options.authBase ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  const now = options.now ?? Date.now;
  const drive = (driveId: string | null) =>
    driveId ? `/drives/${encodeURIComponent(driveId)}` : "/me/drive";
  const tokens = (r: Awaited<ReturnType<typeof tokenRequest>>, prior = ""): TokenSet => ({
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? prior,
    expiresAt: now() + r.expires_in * 1000,
  });

  async function pages<T>(
    token: string,
    first: string,
  ): Promise<{ values: T[]; deltaLink?: string }> {
    const values: T[] = [];
    let url: string | undefined = first;
    let deltaLink: string | undefined;
    while (url) {
      const res: { value: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } =
        await json(options, url, token);
      values.push(...res.value);
      deltaLink = res["@odata.deltaLink"] ?? deltaLink;
      url = res["@odata.nextLink"];
    }
    return { values, ...(deltaLink ? { deltaLink } : {}) };
  }

  const children = (token: string, driveId: string | null, folderId: string | null) =>
    pages<GraphItem>(
      token,
      `${graph}${drive(driveId)}/${folderId ? `items/${encodeURIComponent(folderId)}` : "root"}/children?$top=200`,
    ).then((r) => r.values.map(toItem));

  return {
    id: "sharepoint",
    authorizeUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        response_mode: "query",
        scope: SCOPES,
        state,
      });
      return `${authBase}/authorize?${params}`;
    },
    async exchangeCode(code, redirectUri) {
      const r = await tokenRequest(options, `${authBase}/token`, {
        code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: SCOPES,
      });
      const set = tokens(r);
      if (!set.refreshToken) throw new ProviderError("UPSTREAM", "No refresh token was granted.");
      const me = await json<{ userPrincipalName?: string; mail?: string }>(
        options,
        `${graph}/me?$select=userPrincipalName,mail`,
        set.accessToken,
      ).catch(() => ({}) as { userPrincipalName?: string; mail?: string });
      return { ...set, accountLabel: me.mail ?? me.userPrincipalName ?? "" };
    },
    async refresh(refreshToken) {
      const r = await tokenRequest(options, `${authBase}/token`, {
        refresh_token: refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
        scope: SCOPES,
      });
      // Microsoft rotates the refresh token; the new one replaces the old.
      return tokens(r, refreshToken);
    },
    browse: (token, { driveId, folderId }) =>
      children(token, driveId, folderId).then((items) =>
        items.sort((a, b) => a.name.localeCompare(b.name)),
      ),
    async search(token, driveId, query) {
      const safe = query.replaceAll("'", "''");
      const res = await json<{ value: GraphItem[] }>(
        options,
        `${graph}${drive(driveId)}/root/search(q='${encodeURIComponent(safe)}')?$top=25`,
        token,
      );
      return res.value
        .filter((g) => !g.folder)
        .map(
          (g): SearchHit => ({
            id: g.id,
            title: g.name ?? "",
            url: g.webUrl ?? null,
            snippet: "",
            modified_at: g.lastModifiedDateTime ?? null,
          }),
        );
    },
    async getItem(token, scope, id) {
      try {
        return toItem(
          await json<GraphItem>(
            options,
            `${graph}${drive(scope.driveId)}/items/${encodeURIComponent(id)}`,
            token,
          ),
        );
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) return null;
        throw err;
      }
    },
    async startToken(token, scope) {
      // token=latest answers with the current delta link and no items.
      const r = await pages<GraphItem>(
        token,
        `${graph}${drive(scope.driveId)}/root/delta?token=latest`,
      );
      if (!r.deltaLink) throw new ProviderError("UPSTREAM", "No delta link was returned.");
      return r.deltaLink;
    },
    async listTree(token, scope) {
      const out: RemoteItem[] = [];
      const queue = [scope.rootId];
      const seen = new Set(queue);
      while (queue.length > 0) {
        const parent = queue.shift() as string;
        for (const item of await children(token, scope.driveId, parent)) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);
          if (item.kind === "folder") queue.push(item.id);
        }
      }
      return out;
    },
    async changes(token, _scope, changeToken) {
      // The token is the full delta link the last run ended on.
      const r = await pages<GraphItem>(token, changeToken);
      const changes: RemoteChange[] = [];
      for (const g of r.values) {
        if (g.root) continue;
        if (g.deleted) changes.push({ id: g.id, removed: true });
        else changes.push({ id: g.id, removed: false, item: toItem(g) });
      }
      return { changes, nextToken: r.deltaLink ?? changeToken };
    },
    async download(token, scope, item): Promise<Download | null> {
      if (item.kind !== "file") return null;
      const res = await call(
        options,
        `${graph}${drive(scope.driveId)}/items/${encodeURIComponent(item.id)}/content`,
        token,
      );
      return { bytes: new Uint8Array(await res.arrayBuffer()), name: item.name, mime: item.mime };
    },
  };
}
