import { describe, expect, it } from "vitest";
import { fileTypeLimit, RetentionHours, RetrievalScope, VAULT_LIMITS } from "./index.js";

const ID = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";

describe("RetrievalScope", () => {
  it("accepts any mix of vaults, folders and documents", () => {
    expect(RetrievalScope.parse({ vault_ids: [ID], folder_ids: [ID] })).toEqual({
      vault_ids: [ID],
      folder_ids: [ID],
    });
    expect(RetrievalScope.parse({})).toEqual({});
  });

  it("rejects an empty list, which would read as 'everything'", () => {
    expect(RetrievalScope.safeParse({ vault_ids: [] }).success).toBe(false);
  });

  it("rejects keys it doesn't know, so a typo can't widen a search", () => {
    expect(RetrievalScope.safeParse({ vault_id: [ID] }).success).toBe(false);
  });
});

describe("file limits", () => {
  it("gives each readable type its own limit", () => {
    expect(fileTypeLimit("Budget.XLSX")?.bytes).toBe(20 * 1024 ** 2);
    expect(fileTypeLimit("mailbox.pst")?.kind).toBe("mailbox");
  });

  it("returns null for types that can't be read", () => {
    expect(fileTypeLimit("photo.heic")).toBeNull();
    expect(fileTypeLimit("README")).toBeNull();
    expect(fileTypeLimit("x.constructor")).toBeNull();
  });

  it("caps a vault at 100,000 files and 100 GB, as the database does", () => {
    expect(VAULT_LIMITS).toEqual({ files: 100_000, bytes: 107_374_182_400 });
  });
});

describe("RetentionHours", () => {
  it("is at least three hours, or none", () => {
    expect(RetentionHours.safeParse(2).success).toBe(false);
    expect(RetentionHours.parse(720)).toBe(720);
    expect(RetentionHours.parse(null)).toBeNull();
  });
});
