import { describe, expect, it } from "vitest";
import type { Citation } from "./api.js";
import { documentStatus, segments } from "./text.js";

const citation = (n: number, at: number): Citation => ({
  n,
  at,
  document_id: null,
  version_id: null,
  document_name: null,
  page: null,
  quote: null,
  char_from: null,
  char_to: null,
  status: "unresolved",
});

describe("segments", () => {
  it("returns the text alone when nothing is cited", () => {
    expect(segments("Plain answer.", [])).toEqual([{ text: "Plain answer." }]);
  });

  it("places each citation where it was in the text", () => {
    const one = citation(1, 6);
    const two = citation(2, 12);
    expect(segments("Liable. Capped.", [two, one])).toEqual([
      { text: "Liable" },
      { citation: one },
      { text: ". Capp" },
      { citation: two },
      { text: "ed." },
    ]);
  });

  it("keeps citations at the same place in number order", () => {
    const one = citation(1, 3);
    const two = citation(2, 3);
    expect(segments("Yes.", [two, one])).toEqual([
      { text: "Yes" },
      { citation: one },
      { citation: two },
      { text: "." },
    ]);
  });

  it("puts a citation past the end at the end, rather than dropping it", () => {
    const late = citation(1, 99);
    expect(segments("Short", [late])).toEqual([{ text: "Short" }, { citation: late }]);
  });
});

describe("documentStatus", () => {
  const base = {
    id: "d",
    version_id: "v",
    name: "a.pdf",
    mime: "application/pdf",
    size: 1,
    status: "indexed" as const,
    failure_reason: null,
    page_count: 3,
    empty_page_count: 0,
    matter_id: null,
    created_at: "2026-11-14T00:00:00Z",
  };

  it("counts pages once a file is read", () => {
    expect(documentStatus(base)).toBe("3 pages");
    expect(documentStatus({ ...base, page_count: 1 })).toBe("1 page");
  });

  it("says a file is still being read", () => {
    expect(documentStatus({ ...base, status: "queued", page_count: null })).toBe(
      "Waiting to be read",
    );
    expect(documentStatus({ ...base, status: "parsing", page_count: null })).toBe("Reading");
  });

  it("explains a failure in plain words, even an unknown one", () => {
    expect(documentStatus({ ...base, status: "failed", failure_reason: "NO_TEXT" })).toBe(
      "No text was found.",
    );
    expect(documentStatus({ ...base, status: "failed", failure_reason: "SOMETHING_NEW" })).toBe(
      "The file couldn't be processed.",
    );
  });
});
