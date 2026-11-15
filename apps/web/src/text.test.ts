import { describe, expect, it } from "vitest";
import { documentStatus } from "./text.js";

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
