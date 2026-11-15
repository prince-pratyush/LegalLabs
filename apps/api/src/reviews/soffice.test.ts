import { buildDocx } from "@legallabs/docx";
import { describe, expect, it } from "vitest";
import { sofficeValidator, validatorFromEnv } from "./soffice.js";

describe("redline validation", () => {
  it("is off unless asked for", () => {
    expect(validatorFromEnv({})).toBeNull();
    expect(validatorFromEnv({ LEGALLABS_SOFFICE_VALIDATE: "1" })).toBeTypeOf("function");
  });

  it("says no when LibreOffice can't be run", async () => {
    const validate = sofficeValidator("/nonexistent/soffice");
    expect(await validate(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  // SOFFICE_TEST=1 npx vitest run src/reviews/soffice.test.ts
  it.skipIf(process.env.SOFFICE_TEST !== "1")(
    "opens a real .docx with LibreOffice",
    async () => {
      const docx = buildDocx({
        blocks: [{ kind: "paragraph", runs: [{ text: "Hello." }] }],
        author: "Test",
        date: "2026-01-01T00:00:00Z",
      });
      expect(await sofficeValidator()(docx)).toBe(true);
    },
    120_000,
  );
});
