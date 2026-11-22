import { defineConfig } from "vitest/config";

// The SAML test needs a running Zitadel stack, not the test Postgres, so no globalSetup.
export default defineConfig({
  test: { include: ["src/auth/saml.zitadel.test.ts"], testTimeout: 120_000 },
});
