import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-ins for the Google Drive v3 and Microsoft Graph v1.0 endpoints the sync
 * uses, shaped from the vendors' public documentation. They are the only thing the sync has
 * been run against: real-account behaviour is UNVERIFIED.
 */
export interface MockServer {
  url: string;
  close(): Promise<void>;
  /** Every request path, for assertions about what the sync called. */
  requests: string[];
  /** Access tokens the server accepts; a refresh adds a new one. */
  validTokens: Set<string>;
  /** Refresh tokens that still work. */
  refreshTokens: Set<string>;
  /** Answer the next n requests with 429 and Retry-After: 0. */
  throttle: number;
  /** Answer 410 to the next change query. */
  expireChangeToken: boolean;
}

interface Base {
  start(): Promise<MockServer>;
}

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

function listen(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, srv: MockServer) => void,
): Promise<MockServer> {
  const srv = {
    requests: [] as string[],
    validTokens: new Set<string>(["access-1"]),
    refreshTokens: new Set<string>(["refresh-1"]),
    throttle: 0,
    expireChangeToken: false,
  } as MockServer;
  let issued = 1;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    srv.requests.push(`${req.method} ${url.pathname}${url.search ? "?" : ""}`);
    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const send = (code: number, o: object) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        if (form.get("grant_type") === "authorization_code") {
          issued++;
          const access = `access-${issued}`;
          srv.validTokens.add(access);
          srv.refreshTokens.add(`refresh-${issued}`);
          return send(200, {
            access_token: access,
            refresh_token: `refresh-${issued}`,
            expires_in: 3600,
          });
        }
        const rt = form.get("refresh_token") ?? "";
        if (!srv.refreshTokens.has(rt)) return send(400, { error: "invalid_grant" });
        issued++;
        const access = `access-${issued}`;
        srv.validTokens.add(access);
        send(200, { access_token: access, refresh_token: rt, expires_in: 3600 });
      });
      return;
    }
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!srv.validTokens.has(bearer)) {
      res.writeHead(401).end(JSON.stringify({ error: { message: "invalid credentials" } }));
      return;
    }
    if (srv.throttle > 0) {
      srv.throttle--;
      res.writeHead(429, { "retry-after": "0" }).end("slow down");
      return;
    }
    handler(req, res, url, srv);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      srv.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      srv.close = () => new Promise((r) => server.close(() => r()));
      resolve(srv);
    });
  });
}

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  res.writeHead(code, { "content-type": type });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

// ---------------------------------------------------------------- Google Drive

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  version: number;
  trashed: boolean;
  modifiedTime: string;
}

export class MockDrive implements Base {
  files = new Map<string, GFile>();
  /** Folders whose permission was revoked: reads answer 404 and children report as removed. */
  revoked = new Set<string>();
  private log: { fileId: string; removed: boolean }[] = [];
  private seq = 0;
  server!: MockServer;

  async start() {
    this.server = await listen((req, res, url, srv) => this.handle(req, res, url, srv));
    return this.server;
  }

  put(
    name: string,
    parent: string,
    content: string | Buffer,
    mimeType = "text/plain",
    id?: string,
  ) {
    const fid = id ?? `f${++this.seq}`;
    const prior = this.files.get(fid);
    this.files.set(fid, {
      id: fid,
      name,
      mimeType,
      parents: [parent],
      content: Buffer.from(content),
      version: (prior?.version ?? 0) + 1,
      trashed: false,
      modifiedTime: new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.seq)).toISOString(),
    });
    this.log.push({ fileId: fid, removed: false });
    return fid;
  }
  folder(name: string, parent: string, id?: string) {
    return this.put(name, parent, "", "application/vnd.google-apps.folder", id);
  }
  rename(id: string, name: string) {
    const f = this.files.get(id) as GFile;
    f.name = name;
    this.log.push({ fileId: id, removed: false });
  }
  move(id: string, parent: string) {
    const f = this.files.get(id) as GFile;
    f.parents = [parent];
    this.log.push({ fileId: id, removed: false });
  }
  trash(id: string) {
    (this.files.get(id) as GFile).trashed = true;
    this.log.push({ fileId: id, removed: false });
  }
  remove(id: string) {
    this.files.delete(id);
    this.log.push({ fileId: id, removed: true });
  }

  private meta(f: GFile) {
    const folder = f.mimeType === "application/vnd.google-apps.folder";
    const native = f.mimeType.startsWith("application/vnd.google-apps.");
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: f.trashed,
      version: String(f.version),
      modifiedTime: f.modifiedTime,
      ...(folder || native ? {} : { size: String(f.content.length), md5Checksum: md5(f.content) }),
      webViewLink: `https://drive.example/${f.id}`,
    };
  }

  private hidden(f: GFile): boolean {
    return [f.id, ...f.parents].some((id) => this.revoked.has(id));
  }

  private handle(_req: IncomingMessage, res: ServerResponse, url: URL, srv: MockServer) {
    const p = url.pathname;
    if (p === "/about") return send(res, 200, { user: { emailAddress: "ana@example.test" } });
    if (p === "/changes/startPageToken")
      return send(res, 200, { startPageToken: String(this.log.length) });
    if (p === "/changes") {
      if (srv.expireChangeToken) {
        srv.expireChangeToken = false;
        return send(res, 410, { error: { message: "startPageToken is no longer valid" } });
      }
      const from = Number(url.searchParams.get("pageToken"));
      // Two entries per page, to exercise paging.
      const slice = this.log.slice(from, from + 2);
      const next = from + slice.length;
      const changes = slice.map((c) => {
        const f = this.files.get(c.fileId);
        if (c.removed || !f) return { fileId: c.fileId, removed: true };
        if (this.hidden(f)) return { fileId: c.fileId, removed: true };
        return { fileId: c.fileId, removed: false, file: this.meta(f) };
      });
      return send(res, 200, {
        changes,
        ...(next < this.log.length
          ? { nextPageToken: String(next) }
          : { newStartPageToken: String(next) }),
      });
    }
    if (p === "/files") {
      const q = url.searchParams.get("q") ?? "";
      const inParent = /^'([^']+)' in parents/.exec(q);
      let list = [...this.files.values()].filter((f) => !f.trashed && !this.hidden(f));
      if (inParent) list = list.filter((f) => f.parents.includes(inParent[1] as string));
      const ft = /fullText contains '([^']*)'/.exec(q);
      if (ft) list = list.filter((f) => f.content.toString().includes(ft[1] as string));
      return send(res, 200, { files: list.map((f) => this.meta(f)) });
    }
    const m = /^\/files\/([^/]+)(\/export)?$/.exec(p);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1] as string));
      if (!f || this.hidden(f)) return send(res, 404, { error: { message: "File not found" } });
      if (m[2]) {
        const body = Buffer.concat([Buffer.from("PK\x03\x04"), f.content]);
        return send(res, 200, body, url.searchParams.get("mimeType") ?? "application/octet-stream");
      }
      if (url.searchParams.get("alt") === "media") return send(res, 200, f.content, f.mimeType);
      return send(res, 200, this.meta(f));
    }
    send(res, 404, { error: { message: "no such route" } });
  }
}

// ---------------------------------------------------------------- Microsoft Graph

interface GItem {
  id: string;
  name: string;
  parent: string;
  folder: boolean;
  content: Buffer;
  ctag: number;
  etag: number;
  deleted: boolean;
}

export class MockGraph implements Base {
  items = new Map<string, GItem>([
    [
      "root",
      {
        id: "root",
        name: "root",
        parent: "",
        folder: true,
        content: Buffer.alloc(0),
        ctag: 1,
        etag: 1,
        deleted: false,
      },
    ],
  ]);
  private log: string[] = [];
  private seq = 0;
  server!: MockServer;
  revoked = new Set<string>();

  async start() {
    this.server = await listen((req, res, url, srv) => this.handle(req, res, url, srv));
    return this.server;
  }

  put(name: string, parent: string, content: string | Buffer, id?: string, folder = false) {
    const iid = id ?? `i${++this.seq}`;
    const prior = this.items.get(iid);
    this.items.set(iid, {
      id: iid,
      name,
      parent,
      folder,
      content: Buffer.from(content),
      ctag: (prior?.ctag ?? 0) + 1,
      etag: (prior?.etag ?? 0) + 1,
      deleted: false,
    });
    this.log.push(iid);
    return iid;
  }
  folder(name: string, parent: string, id?: string) {
    return this.put(name, parent, "", id, true);
  }
  rename(id: string, name: string) {
    const i = this.items.get(id) as GItem;
    i.name = name;
    i.etag++;
    this.log.push(id);
  }
  move(id: string, parent: string) {
    const i = this.items.get(id) as GItem;
    i.parent = parent;
    i.etag++;
    this.log.push(id);
  }
  remove(id: string) {
    (this.items.get(id) as GItem).deleted = true;
    this.log.push(id);
  }

  private json(i: GItem) {
    return {
      id: i.id,
      name: i.name,
      parentReference: { id: i.parent },
      ...(i.folder
        ? { folder: { childCount: 0 } }
        : { file: { mimeType: "text/plain" }, size: i.content.length }),
      cTag: `c${i.ctag}`,
      eTag: `e${i.etag}`,
      webUrl: `https://tenant.sharepoint.example/${i.id}`,
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
      ...(i.deleted ? { deleted: { state: "deleted" } } : {}),
    };
  }

  private handle(_req: IncomingMessage, res: ServerResponse, url: URL, srv: MockServer) {
    const p = url.pathname;
    if (p === "/me") return send(res, 200, { userPrincipalName: "ana@tenant.test" });
    const root = /^\/(?:me\/drive|drives\/[^/]+)(\/.*)$/.exec(p);
    if (!root) return send(res, 404, { error: { code: "itemNotFound" } });
    const rest = root[1] as string;
    if (rest === "/root/delta") {
      if (srv.expireChangeToken) {
        srv.expireChangeToken = false;
        return send(res, 410, { error: { code: "resyncRequired" } });
      }
      const tok = url.searchParams.get("token") ?? "0";
      const from = tok === "latest" ? this.log.length : Number(tok);
      const slice = this.log.slice(from);
      // Page size two, ending with a deltaLink, as the docs describe.
      const page = slice.slice(0, 2);
      const next = from + page.length;
      const value = page.map((id) => this.json(this.items.get(id) as GItem));
      const link = `${srv.url}/drives/d1/root/delta?token=${next}`;
      return send(res, 200, {
        value,
        ...(next < this.log.length ? { "@odata.nextLink": link } : { "@odata.deltaLink": link }),
      });
    }
    const children = /^\/(?:root|items\/([^/]+))\/children$/.exec(rest);
    if (children) {
      const parent = children[1] ? decodeURIComponent(children[1]) : "root";
      const list = [...this.items.values()].filter(
        (i) => i.parent === parent && !i.deleted && !this.revoked.has(i.id),
      );
      return send(res, 200, { value: list.map((i) => this.json(i)) });
    }
    const search = /^\/root\/search\(q='(.*)'\)$/.exec(decodeURIComponent(rest));
    if (search) {
      const q = search[1] as string;
      const hits = [...this.items.values()].filter((i) => !i.deleted && i.name.includes(q));
      return send(res, 200, { value: hits.map((i) => this.json(i)) });
    }
    const item = /^\/items\/([^/]+)(\/content)?$/.exec(rest);
    if (item) {
      const i = this.items.get(decodeURIComponent(item[1] as string));
      if (!i || i.deleted || this.revoked.has(i.id))
        return send(res, 404, { error: { code: "itemNotFound" } });
      return item[2]
        ? send(res, 200, i.content, "application/octet-stream")
        : send(res, 200, this.json(i));
    }
    send(res, 404, { error: { code: "itemNotFound" } });
  }
}
