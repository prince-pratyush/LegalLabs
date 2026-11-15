import { defineConfig } from "vitest/config";

// The pilots run against a real server, so they are kept out of the unit test run. One file
// at a time: in CI every stack shares one database and its API role's password.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 180_000,
  },
});
