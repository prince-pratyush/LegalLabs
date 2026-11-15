import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "./host.js";

describe("capabilitiesOf", () => {
  it("edits only where WordApi 1.4 is supported", () => {
    const at = (max: number) => capabilitiesOf((_, v) => Number(v) <= max);
    expect(at(1.3)).toEqual({ tracked: false, comments: false });
    expect(at(1.6)).toEqual({ tracked: true, comments: true });
  });

  it("treats a host that throws as unsupported", () => {
    expect(
      capabilitiesOf(() => {
        throw new Error("no");
      }),
    ).toEqual({ tracked: false, comments: false });
  });
});
