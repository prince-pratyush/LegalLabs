import { describe, expect, it } from "vitest";
import {
  AuditAction,
  DEFAULT_MATTER_OPTIONS,
  MatterCreate,
  MatterOptions,
  matterDisplay,
  matterNumberValid,
  WallProviderConfig,
} from "./index.js";

const acme = {
  client_id: "00123",
  client_name: "Acme Corp",
  matter_number: "0001",
  description: "Share purchase",
};

describe("matterDisplay", () => {
  it("formats client id, separator, number and client name", () => {
    expect(
      matterDisplay(acme, { ...DEFAULT_MATTER_OPTIONS.display_format, show_client_name: true }),
    ).toBe("00123-0001 Acme Corp");
  });

  it("drops the client id and adds the description when asked", () => {
    expect(
      matterDisplay(acme, {
        separator: "/",
        show_client_id: false,
        show_client_name: false,
        show_description: true,
      }),
    ).toBe("0001 Share purchase");
  });
});

describe("matterNumberValid", () => {
  it("checks the workspace pattern, and passes anything without one", () => {
    expect(matterNumberValid("12345-0001", "^\\d{5}-\\d{4}$")).toBe(true);
    expect(matterNumberValid("ABC", "^\\d{5}-\\d{4}$")).toBe(false);
    expect(matterNumberValid("ABC", null)).toBe(true);
  });
});

describe("MatterOptions", () => {
  it("accepts the defaults and refuses a broken pattern", () => {
    expect(MatterOptions.parse(DEFAULT_MATTER_OPTIONS)).toEqual(DEFAULT_MATTER_OPTIONS);
    expect(MatterOptions.safeParse({ ...DEFAULT_MATTER_OPTIONS, id_regex: "(" }).success).toBe(
      false,
    );
  });
});

describe("MatterCreate", () => {
  it("requires the four identifying fields and refuses unknown ones", () => {
    expect(MatterCreate.safeParse({ ...acme, matter_name: "SPA" }).success).toBe(true);
    expect(MatterCreate.safeParse({ ...acme, matter_name: " " }).success).toBe(false);
    expect(MatterCreate.safeParse({ ...acme, matter_name: "SPA", owner: "x" }).success).toBe(false);
  });
});

describe("wall contracts", () => {
  it("names every provider kind, even ones not yet supported", () => {
    expect(WallProviderConfig.parse({ kind: "intapp" }).kind).toBe("intapp");
  });

  it("knows the matter and wall audit actions", () => {
    for (const action of [
      "matter.created",
      "matter.closed",
      "matter.options_updated",
      "wall.share_suspended",
      "wall.share_reinstated",
      "wall.csv_applied",
      "wall.evaluated",
    ]) {
      expect(AuditAction.safeParse(action).success).toBe(true);
    }
  });
});
