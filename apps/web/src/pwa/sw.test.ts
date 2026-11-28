// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const ORIGIN = "https://app.test";
const SOURCE = readFileSync(new URL("./sw.js", import.meta.url), "utf8");

type Listener = (event: Record<string, unknown>) => void;

interface Req {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
}

const request = (
  path: string,
  init: Partial<Omit<Req, "headers">> & { headers?: object } = {},
) => ({
  method: "GET",
  mode: "cors",
  ...init,
  url: new URL(path, ORIGIN).href,
  headers: new Headers(init.headers as Record<string, string>),
});

const response = (body: string, headers: Record<string, string> = {}, status = 200) => {
  const res = new Response(body, { status, headers });
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
};
const immutable = () => ({ "cache-control": "public, max-age=31536000, immutable" });

/** The worker run against an in-memory CacheStorage and a stub network. */
function worker(network: (url: string) => Promise<Response> = async () => response("net")) {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: string | Req) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const fetched: string[] = [];
  const get = (r: string | Req) => {
    const url = key(r);
    fetched.push(url);
    return network(url);
  };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (r: string | Req) => store.get(key(r))?.clone(),
        put: async (r: string | Req, res: Response) => void store.set(key(r), res),
        addAll: async (urls: string[]) => {
          for (const url of urls) store.set(key(url), await get(url));
        },
      };
    },
  };
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function("self", "caches", "fetch", SOURCE)(self, caches, get);

  const dispatch = async (type: string, extra: object = {}) => {
    const waits: unknown[] = [];
    listeners[type]?.({ ...extra, waitUntil: (p: unknown) => waits.push(p) });
    await Promise.all(waits);
  };
  /** What the worker answered with, or null when it left the request to the browser. */
  const handle = async (req: ReturnType<typeof request>) => {
    let answer: Promise<Response> | null = null;
    listeners.fetch?.({
      request: req,
      respondWith: (p: Promise<Response>) => {
        answer = p;
      },
      waitUntil: () => {},
    });
    return answer as Promise<Response> | null;
  };
  const cached = () => [...stores.values()].flatMap((s) => [...s.keys()]);
  return { dispatch, handle, stores, cached, fetched };
}

describe("what the worker leaves alone", () => {
  test.each([
    "/api/v1/session",
    "/api/v1/runs/1/events",
    "/api/v1/documents/1/file",
    "/auth/login",
    "/guest/login",
    "/hooks/email/k",
    "/scim/v2/Users",
    "/addin/taskpane.html",
    "/addin/assets/pane.js",
    "/assets/../api/v1/session",
    "/documents/1/file.pdf",
    "/sw.js",
  ])("passes %s to the browser", async (path) => {
    expect(await worker().handle(request(path))).toBeNull();
  });

  test.each(["/auth/oidc/start", "/auth/oidc/callback?code=x", "/api/v1/x", "/addin/auth.html"])(
    "does not intercept the navigation to %s",
    async (path) => {
      expect(await worker().handle(request(path, { mode: "navigate" }))).toBeNull();
    },
  );

  test("ignores writes, other origins, bearer and range requests", async () => {
    const w = worker();
    for (const req of [
      request("/assets/a.js", { method: "POST" }),
      request("https://elsewhere.test/assets/a.js"),
      request("/assets/a.js", { headers: { authorization: "Bearer t" } }),
      request("/assets/a.js", { headers: { range: "bytes=0-1" } }),
      request("/assets/a.js?token=1"),
    ]) {
      expect(await w.handle(req)).toBeNull();
    }
  });
});

describe("app shell", () => {
  test("precaches only the offline page, its style and an icon", async () => {
    const w = worker();
    await w.dispatch("install");
    expect(w.cached().sort()).toEqual(
      ["/icon-192.png", "/offline.css", "/offline.html"].map((p) => ORIGIN + p),
    );
  });

  test("keeps a build asset the server marked immutable", async () => {
    const w = worker(async () => response("code", immutable()));
    expect(await (await w.handle(request("/assets/a-1.js")))?.text()).toBe("code");
    expect(await (await w.handle(request("/assets/a-1.js")))?.text()).toBe("code");
    expect(w.fetched).toHaveLength(1);
  });

  test.each([
    ["no immutable mark", () => response("x", { "cache-control": "no-store" })],
    ["an error", () => response("x", immutable(), 404)],
    ["a web page", () => response("x", { ...immutable(), "content-type": "text/html" })],
  ])("does not keep an asset answer with %s", async (_, answer) => {
    const w = worker(async () => answer());
    await w.handle(request("/assets/a-1.js"));
    expect(w.cached()).toEqual([]);
  });

  test("fetches pages from the network every time and never keeps them", async () => {
    const w = worker(async () => response("page", immutable()));
    for (const path of ["/", "/d/1", "/documents/1", "/guest/accept"]) {
      const res = await w.handle(request(path, { mode: "navigate" }));
      expect(await res?.text()).toBe("page");
    }
    expect(w.cached()).toEqual([]);
  });

  test("hands a redirect or an error page through untouched", async () => {
    const w = worker(async () => response("denied", {}, 401));
    const res = await w.handle(request("/", { mode: "navigate" }));
    expect(res?.status).toBe(401);
  });

  test("shows the offline page when the network is gone", async () => {
    let online = true;
    const w = worker(async (url) => {
      if (!online) throw new TypeError("offline");
      return response(new URL(url).pathname);
    });
    await w.dispatch("install");
    online = false;
    const page = await w.handle(request("/", { mode: "navigate" }));
    expect(await page?.text()).toBe("/offline.html");
    const style = await w.handle(request("/offline.css"));
    expect(await style?.text()).toBe("/offline.css");
  });
});

describe("clearing", () => {
  test("a new version drops older caches and leaves other apps' alone", async () => {
    const w = worker();
    w.stores.set("legallabs-shell-old", new Map());
    w.stores.set("someone-else", new Map());
    await w.dispatch("install");
    await w.dispatch("activate");
    const names = [...w.stores.keys()];
    expect(names).not.toContain("legallabs-shell-old");
    expect(names).toContain("someone-else");
    expect(names.filter((n) => n.startsWith("legallabs-shell-"))).toHaveLength(1);
  });

  test("puts the offline page back after the app cleared the cache", async () => {
    const w = worker();
    await w.dispatch("message", { data: { type: "refill" } });
    expect(w.cached()).toContain(`${ORIGIN}/offline.html`);
  });
});
