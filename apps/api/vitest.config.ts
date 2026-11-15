import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test-setup.ts"],
    // The pilot needs a whole stack; it runs through vitest.e2e.config.ts.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    testTimeout: 20_000,
  },
});
