import { defineConfig } from "vitest/config";

// Typing tests run slowly on shared CI machines.
export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], testTimeout: 20_000 },
});
