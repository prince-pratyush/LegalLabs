import { defineConfig } from "vitest/config";

// The API serves the build on its own origin; while developing, Vite forwards to it instead.
const api = "http://127.0.0.1:8787";

export default defineConfig({
  server: { proxy: { "/api": api, "/auth": api } },
  test: { environment: "jsdom" },
});
