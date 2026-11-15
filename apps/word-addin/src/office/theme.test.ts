import { expect, it } from "vitest";
import { themeOf } from "./theme.js";

it("matches Office's background", () => {
  expect(themeOf("#FFFFFF")).toBe("light");
  expect(themeOf("#262626")).toBe("dark");
  expect(themeOf(undefined)).toBeNull();
  expect(themeOf("not a colour")).toBeNull();
});
