import { describe, expect, it } from "vitest";
import { surfaceOf } from "../threads/surface.js";
import { paneOf, viaOf } from "./via.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Safari/605.1.15";

describe("where a call comes from", () => {
  it("is Word for the pane, a phone by its browser, otherwise the web", () => {
    expect(viaOf(true, IPHONE)).toBe("word");
    expect(viaOf(false, IPHONE)).toBe("mobile");
    expect(viaOf(false, ANDROID)).toBe("mobile");
    expect(viaOf(false, DESKTOP)).toBeUndefined();
    expect(viaOf(false, undefined)).toBeUndefined();
  });

  it("counts a phone under the mobile access point", () => {
    expect(surfaceOf("mobile")).toEqual({ surface: "web", accessPoint: "mobile" });
    expect(surfaceOf("word")).toEqual({ surface: "word", accessPoint: "word" });
    expect(surfaceOf(undefined)).toEqual({ surface: "web", accessPoint: "web" });
  });
});

describe("the Outlook pane", () => {
  it("counts as Outlook only when it carries a pane's bearer token", () => {
    expect(viaOf(true, undefined, "outlook")).toBe("outlook");
    expect(viaOf(true, undefined, "something else")).toBe("word");
    expect(viaOf(false, undefined, "outlook")).toBeUndefined();
    expect(paneOf("outlook")).toBe("outlook");
    expect(paneOf(undefined)).toBe("word");
    expect(surfaceOf("outlook")).toEqual({ surface: "outlook", accessPoint: "outlook" });
  });
});
