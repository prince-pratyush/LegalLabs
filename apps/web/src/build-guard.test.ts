// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, test } from "vitest";

const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

test("the web build fails when a module imports a Node built-in", async () => {
  const bundle = build({
    configFile,
    logLevel: "silent",
    plugins: [
      {
        name: "entry",
        resolveId: (id) => (id === "virtual:entry" ? id : undefined),
        load: (id) =>
          id === "virtual:entry"
            ? 'import { readFileSync } from "node:fs"; readFileSync("x");'
            : null,
      },
    ],
    build: { write: false, rollupOptions: { input: "virtual:entry" } },
  });
  await expect(bundle).rejects.toThrow("virtual:entry imports node:fs");
});
