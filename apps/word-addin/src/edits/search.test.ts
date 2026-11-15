import { expect, it } from "vitest";
import { searchText } from "./search.js";

it("escapes Word's search codes", () => {
  expect(searchText("a^b\tc\vd")).toBe("a^^b^tc^ld");
});
