import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const api = "http://127.0.0.1:8787";
// Outlook only loads a pane over trusted HTTPS; these are the Office dev certificates, when installed.
const certs = join(homedir(), ".office-addin-dev-certs");
const https = existsSync(join(certs, "localhost.crt"))
  ? {
      cert: readFileSync(join(certs, "localhost.crt")),
      key: readFileSync(join(certs, "localhost.key")),
    }
  : undefined;

export default defineConfig({
  // Served by the API under /outlook/, so the pane, its dialog and the API share one origin.
  base: "/outlook/",
  plugins: [
    tailwind(),
    {
      // Vite only warns here and ships a stub that throws on load, leaving a blank pane.
      name: "no-node-modules",
      apply: "build",
      enforce: "pre",
      resolveId(id, importer) {
        if (id.startsWith("node:")) this.error(`${importer} imports ${id}`);
      },
    },
  ],
  server: {
    port: 3001,
    strictPort: true,
    ...(https ? { https } : {}),
    proxy: { "/api": api, "/auth": api },
  },
  build: {
    rollupOptions: { input: { taskpane: "taskpane.html", auth: "auth.html" } },
  },
  // Typing tests run slowly on shared CI machines.
  test: { environment: "jsdom", setupFiles: ["src/test-setup.ts"], testTimeout: 20_000 },
});
