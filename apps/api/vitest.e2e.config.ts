import { defineConfig } from "vitest/config";

// The pilots run against a real server, so they are kept out of the unit test run. One file
// at a time: on CI's shared database the ingest queue is shared too, so one stack's worker
// takes the other's uploads and fails them (MISSING_ORIGINAL) when its object store differs.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 180_000,
  },
});
