import { describe, expect, it } from "vitest";
import { ApiError, messageOf } from "./api.js";
import { messageOf as vaultMessageOf } from "./vaults/shared.js";

describe("messageOf", () => {
  it("shows the server's words, and a plain fallback for anything else", () => {
    expect(messageOf(new ApiError(409, "STALE", "Reload first."))).toBe("Reload first.");
    expect(messageOf(new TypeError("fetch failed"))).toBe("Something went wrong. Try again.");
  });

  it("is the one helper every page uses", () => {
    expect(vaultMessageOf).toBe(messageOf);
  });
});
