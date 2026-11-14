import { describe, expect, it } from "vitest";
import { Anchor, citationHref, parseDocumentHref, viewerPaths } from "./index.js";

const anchor = {
  document_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
  version_id: "01933b8a-7c2f-7a11-8b22-000000000001",
  page: 12,
  char_from: 340,
  char_to: 410,
};

describe("Anchor", () => {
  it("accepts a span on a page", () => {
    expect(Anchor.parse(anchor)).toEqual(anchor);
  });

  it("accepts a page with no span", () => {
    expect(Anchor.safeParse({ ...anchor, char_from: null, char_to: null }).success).toBe(true);
  });

  it("rejects half a span", () => {
    expect(Anchor.safeParse({ ...anchor, char_to: null }).success).toBe(false);
  });

  it("rejects an empty span", () => {
    expect(Anchor.safeParse({ ...anchor, char_to: 340 }).success).toBe(false);
  });
});

describe("citationHref", () => {
  it("round-trips through parseDocumentHref", () => {
    const href = citationHref(anchor);
    expect(href).toBe(
      `/documents/${anchor.document_id}?v=${anchor.version_id}&page=12&span=340-410`,
    );
    expect(parseDocumentHref(href)).toEqual({
      document_id: anchor.document_id,
      version_id: anchor.version_id,
      page: 12,
      span: { from: 340, to: 410 },
    });
  });

  it("never puts the quote in the link", () => {
    expect(citationHref({ ...anchor, quote: "secret clause" })).not.toContain("secret");
  });
});

describe("parseDocumentHref", () => {
  it("ignores links to anything else", () => {
    expect(parseDocumentHref("/threads/abc")).toBeNull();
    expect(parseDocumentHref("/documents/not-an-id")).toBeNull();
  });

  it("drops parameters it can't trust", () => {
    expect(
      parseDocumentHref(`/documents/${anchor.document_id}?v=x&page=-1&span=9-3`),
    ).toEqual({ document_id: anchor.document_id, version_id: null, page: null, span: null });
  });
});

describe("viewerPaths", () => {
  it("escapes the search query", () => {
    expect(viewerPaths.search(anchor.document_id, anchor.version_id, "a&b")).toMatch(/q=a%26b$/);
  });
});
