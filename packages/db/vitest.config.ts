import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 20_000,
    // audit-integrity truncates admin.audit_event, which needs an exclusive lock on the table and
    // its partitions. Run beside any file that inserts audit rows, the two wait on each other and
    // Postgres reports a deadlock. One file at a time removes the cycle.
    fileParallelism: false,
  },
});
