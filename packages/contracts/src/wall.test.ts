import { describe, expect, it } from "vitest";
import { Wall, WallMode } from "./index.js";

const row = {
  id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
  matter_id: "01933b8a-7c2f-7a11-8b22-000000000001",
  principal_type: "group",
  principal_id: "01933b8a-7c2f-7a11-8b22-000000000002",
  effect: "allow",
  provider: "internal",
};

describe("WallMode", () => {
  it("is open or allow_list", () => {
    expect(WallMode.options).toEqual(["open", "allow_list"]);
  });
});

describe("Wall", () => {
  it("accepts an allow row for a group", () => {
    expect(Wall.parse(row)).toEqual(row);
  });

  it("rejects a space as a principal, because walls bind people", () => {
    expect(Wall.safeParse({ ...row, principal_type: "space" }).success).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(Wall.safeParse({ ...row, provider: "spreadsheet" }).success).toBe(false);
  });
});
