import { describe, expect, it } from "vitest";
import { Id } from "./index.js";

describe("Id", () => {
  it("accepts a UUIDv7", () => {
    expect(Id.safeParse("01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f").success).toBe(true);
  });

  it("rejects a UUIDv4, because IDs must sort by creation time", () => {
    expect(Id.safeParse("9b2f8c1e-4d3a-4e5b-8c7d-1a2b3c4d5e6f").success).toBe(false);
  });

  it("rejects text that is not a UUID", () => {
    expect(Id.safeParse("matter-42").success).toBe(false);
  });
});
