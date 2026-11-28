import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import tailwind from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// The API serves the build on its own origin; while developing, Vite forwards to it instead.
const api = "http://127.0.0.1:8787";

// The worker is stamped with a hash of what it ships beside, so any new build replaces its cache.
function serviceWorker(): Plugin {
  const publicDir = new URL("./public/", import.meta.url);
  return {
    name: "service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const source = readFileSync(new URL("./src/pwa/sw.js", import.meta.url), "utf8");
      const hash = createHash("sha256").update(source);
      for (const name of Object.keys(bundle).sort()) hash.update(name);
      for (const name of readdirSync(publicDir).sort()) {
        hash.update(readFileSync(new URL(name, publicDir)));
      }
      const version = hash.digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: source.replaceAll("__VERSION__", version),
      });
    },
  };
}

export default defineConfig({
  plugins: [
    tailwind(),
    serviceWorker(),
    {
      // Vite only warns here and ships a stub that throws on load, leaving a blank page.
      name: "no-node-modules",
      apply: "build",
      enforce: "pre",
      resolveId(id, importer) {
        if (id.startsWith("node:")) this.error(`${importer} imports ${id}`);
      },
    },
  ],
  // Only the guest API: /guest/accept is a page of this app.
  server: {
    proxy: { "/api": api, "/auth": api, "/guest/invites": api, "/guest/login": api },
  },
  test: { environment: "jsdom", testTimeout: 20_000 },
});
