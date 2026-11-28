import { describe, expect, it } from "vitest";
import { createItemText } from "./item-text.js";
import type { ScanSourceId } from "./scan.js";
import { fakeHttp } from "./testing.js";

// Synthetic answers, shaped like each source's published API.

const FR = "https://www.federalregister.gov/api/v1/documents/2026-00001.json";
const BODY = "https://www.federalregister.gov/documents/full_text/html/2026/03/01/2026-00001.html";

const read = (
  source: ScanSourceId,
  externalId: string,
  routes: Record<string, unknown> = {},
  seen: string[] = [],
) => createItemText({ http: () => fakeHttp(routes, seen) })(source, externalId);

const frRoutes = {
  [FR]: {
    document_number: "2026-00001",
    title: "Widget Labelling",
    type: "Rule",
    publication_date: "2026-03-01",
    body_html_url: BODY,
  },
  [BODY]: "<p>Every widget must carry a label.</p><script>x()</script>",
};

describe("the text of one scanned item", () => {
  it("reads a Federal Register document's words and nothing of its scripts", async () => {
    expect(await read("fr", "2026-00001", frRoutes)).toBe("Every widget must carry a label.");
  });

  it("reads one CFR section as it stood when it changed", async () => {
    const seen: string[] = [];
    const url = "https://www.ecfr.gov/api/versioner/v1/full/2026-03-02/title-16.xml";
    const xml =
      '<DIV8 N="§ 305.2" TYPE="SECTION"><HEAD>§ 305.2 Labels.</HEAD><P>Label it.</P></DIV8>';
    expect(await read("ecfr", "16/305.2@2026-03-02", { [url]: xml }, seen)).toContain("Label it.");
    expect(seen).toEqual([`${url}?part=305&section=305.2`]);
  });

  it("fetches nothing for a name that is not the source's", async () => {
    for (const [source, name] of [
      ["fr", "../../etc"],
      ["fr", "https://evil.test/x"],
      ["ecfr", "16/../x@2026-03-02"],
      ["ecfr", "16/305.2"],
      ["uk_legislation", "ukpga/2026/1/../../x"],
      ["uk_legislation", "mystery/2026/1"],
    ] as const) {
      const seen: string[] = [];
      expect(await read(source, name, {}, seen)).toBeNull();
      expect(seen).toEqual([]);
    }
  });

  it("answers nothing when the source has no text", async () => {
    expect(await read("fr", "2026-00001", {})).toBeNull();
    expect(await read("uk_legislation", "uksi/2026/7", {})).toBeNull();
  });
});
