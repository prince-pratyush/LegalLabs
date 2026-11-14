// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { anchorOf, openCitation } from "./open-citation.js";

const citation = {
  document_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
  version_id: "01933b8a-7c2f-7a11-8b22-000000000001",
  page: 3,
  char_from: 10,
  char_to: 40,
  quote: "the supplier accepts liability",
  status: "ok" as const,
};

describe("anchorOf", () => {
  it("turns a thread citation into an anchor", () => {
    expect(anchorOf(citation)).toMatchObject({ page: 3, char_from: 10, char_to: 40 });
  });

  it("gives nothing to open for an unresolved citation or one with no page", () => {
    expect(anchorOf({ ...citation, status: "unresolved" })).toBeNull();
    expect(anchorOf({ ...citation, page: null })).toBeNull();
  });
});

describe("openCitation", () => {
  it("puts the location in the URL and the quote only in history state", () => {
    const anchor = anchorOf(citation);
    const other = anchorOf({ ...citation, page: 5 });
    if (!anchor || !other) throw new Error("expected anchors");
    openCitation(other, { context: [anchor, other] });
    expect(window.location.pathname).toBe(`/documents/${citation.document_id}`);
    expect(window.location.search).toBe(`?v=${citation.version_id}&page=5&span=10-40`);
    expect(window.location.href).not.toContain("liability");
    expect(window.history.state).toMatchObject({ index: 1, anchor: { quote: citation.quote } });
  });
});
