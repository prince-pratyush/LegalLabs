import { describe, expect, it } from "vitest";
import { columnProblem, listOptions, presetColumn } from "./presets.js";

describe("presetColumn", () => {
  it("makes Yes/No a closed classify column", () => {
    const column = presetColumn("yesno", " Change of control ", "Is there one?");
    expect(column.type).toBe("classify");
    expect(column.label).toBe("Change of control");
    expect(column.options).toMatchObject({ allow_other: false, allow_multiple: false });
  });

  it("makes List a multi-select classify column with unique option ids", () => {
    const column = presetColumn("list", "Risks", "Which risks?", ["Cap", "cap", "Indemnity", " "]);
    expect(column.options).toEqual({
      options: [
        { id: "cap", label: "Cap", color: "blue" },
        { id: "indemnity", label: "Indemnity", color: "green" },
      ],
      allow_multiple: true,
      allow_other: true,
    });
  });

  it("maps Money to currency and Clause to verbatim", () => {
    expect(presetColumn("money", "Fee", "Fee?").type).toBe("currency");
    expect(presetColumn("clause", "Clause", "Quote it").type).toBe("verbatim");
  });
});

describe("columnProblem", () => {
  it("asks for a name, a prompt and two list labels", () => {
    expect(columnProblem("text", "", "x", [])).toBe("Name the column.");
    expect(columnProblem("text", "Law", " ", [])).toBe("Say what to look for.");
    expect(columnProblem("manual", "Notes", "", [])).toBeNull();
    expect(columnProblem("list", "Risks", "Which?", ["One"])).toBe("Give at least two labels.");
  });

  it("gives non-latin labels a fallback id", () => {
    expect(listOptions(["日本", "中国"]).map((o) => o.id)).toEqual(["option_1", "option_2"]);
  });
});
