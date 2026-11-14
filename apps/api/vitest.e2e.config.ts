import { defineConfig } from "vitest/config";

// The pilot runs against a real server, so it is kept out of the unit test run.
export default defineConfig({
  test: { include: ["e2e/**/*.test.ts"], testTimeout: 30 * 60_000, hookTimeout: 180_000 },
});
