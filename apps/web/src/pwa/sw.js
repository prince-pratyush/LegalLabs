// Keeps the public app shell only. Pages, the API, sign-in and documents always go to the network
// and are never stored. The build stamps the cache name below.
const PREFIX = "legallabs-shell-";
const CACHE = `${PREFIX}__VERSION__`;
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/offline.css", "/icon-192.png"];
// An allow-list: anything not named here is the browser's business.
const PAGE = /^\/(?:|index\.html|guest\/accept|(?:documents|d)\/[^.]*)$/;
const ASSET = /^\/assets\/[^/]+\.(?:js|mjs|css|woff2?|png|svg)$/;

const fill = async () => (await caches.open(CACHE)).addAll(PRECACHE);

self.addEventListener("install", (event) => {
  event.waitUntil(fill().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(PREFIX) && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "refill") event.waitUntil(fill());
});

const page = async (request) => {
  try {
    return await fetch(request);
  } catch (error) {
    const offline = await (await caches.open(CACHE)).match(OFFLINE);
    if (offline) return offline;
    throw error;
  }
};

// Only what the server itself says is public and unchanging.
const keepable = (res) =>
  res.status === 200 &&
  res.type === "basic" &&
  !res.redirected &&
  (res.headers.get("cache-control") ?? "").includes("immutable") &&
  !(res.headers.get("content-type") ?? "").includes("text/html");

const stored = async (request) => {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // A full or blocked store must not fail the request.
  if (keepable(res)) await cache.put(request, res.clone()).catch(() => {});
  return res;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.headers.has("authorization") || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    if (PAGE.test(url.pathname)) event.respondWith(page(request));
    return;
  }
  if (url.search) return;
  if (ASSET.test(url.pathname) || PRECACHE.includes(url.pathname)) {
    event.respondWith(stored(request));
  }
});
