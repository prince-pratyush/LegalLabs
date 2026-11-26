import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// The API serves the build on its own origin; while developing, Vite forwards to it instead.
const api = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [tailwind()],
  // Only the guest API: /guest/accept is a page of this app.
  server: {
    proxy: { "/api": api, "/auth": api, "/guest/invites": api, "/guest/login": api },
  },
  test: { environment: "jsdom", testTimeout: 20_000 },
});
