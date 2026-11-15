import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Says whether a .docx opens: LibreOffice must convert it to a PDF (spec §4.6). */
export type DocxValidator = (bytes: Uint8Array) => Promise<boolean>;

/**
 * A validator that runs LibreOffice headless. Each call gets its own profile directory, so
 * calls running at once don't fight over LibreOffice's user lock.
 */
export function sofficeValidator(binary = "soffice", timeoutMs = 120_000): DocxValidator {
  return async (bytes) => {
    const dir = await mkdtemp(join(tmpdir(), "redline-check-"));
    try {
      const input = join(dir, "redline.docx");
      await writeFile(input, bytes);
      const ok = await new Promise<boolean>((resolve) => {
        execFile(
          binary,
          [
            `-env:UserInstallation=file://${join(dir, "profile")}`,
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            dir,
            input,
          ],
          { timeout: timeoutMs },
          (err) => resolve(!err),
        );
      });
      if (!ok) return false;
      const pdf = await readFile(join(dir, "redline.pdf")).catch(() => null);
      return pdf !== null && pdf.subarray(0, 4).toString() === "%PDF";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** On only when LEGALLABS_SOFFICE_VALIDATE=1, since LibreOffice is a large optional install. */
export const validatorFromEnv = (env: Record<string, string | undefined>) =>
  env.LEGALLABS_SOFFICE_VALIDATE === "1" ? sofficeValidator(env.SOFFICE_BIN || "soffice") : null;
