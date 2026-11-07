import { describe, expect, it } from "vitest";
import { ErrorBody } from "./index.js";

describe("ErrorBody", () => {
  it("accepts a code, a message and optional details", () => {
    const body = {
      code: "WALL_SHARE_BLOCKED",
      message: "1 recipient cannot be given access to this matter.",
      details: { blocked_count: 1 },
    };
    expect(ErrorBody.parse(body)).toEqual(body);
  });

  it("accepts a body without details", () => {
    expect(ErrorBody.safeParse({ code: "NOT_FOUND", message: "Not found." }).success).toBe(true);
  });

  it("rejects a code clients cannot match on", () => {
    expect(ErrorBody.safeParse({ code: "wall share blocked", message: "x" }).success).toBe(false);
  });
});
