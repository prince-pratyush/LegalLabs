import { describe, expect, it } from "vitest";
import {
  columnReferences,
  dependentsOf,
  findCycle,
  inRunOrder,
  promptForDisplay,
  promptForModel,
  promptFromDisplay,
} from "./review-table-references.js";

const A = "0194f3a0-0000-7000-8000-00000000000a";
const B = "0194f3a0-0000-7000-8000-00000000000b";
const C = "0194f3a0-0000-7000-8000-00000000000c";

describe("column references", () => {
  it("lists each referenced column once, in order", () => {
    expect(columnReferences(`Compare @{${B}} with @{${A}} and @{${B}} again`)).toEqual([B, A]);
    expect(columnReferences("No references, even an email a@b.test or @{not an id}")).toEqual([]);
  });

  it("shows labels and reads them back as ids", () => {
    const columns = [
      { id: A, label: "Governing law" },
      { id: B, label: "Term" },
    ];
    const shown = promptForDisplay(
      `Is @{${A}} the same as in @{${B}}?`,
      (id) => columns.find((c) => c.id === id)?.label,
    );
    expect(shown).toBe("Is @{Governing law} the same as in @{Term}?");
    expect(promptFromDisplay(shown, columns)).toEqual({
      prompt: `Is @{${A}} the same as in @{${B}}?`,
      unknown: [],
      ambiguous: [],
    });
  });

  it("matches labels ignoring case and reports the ones it can't place", () => {
    const columns = [
      { id: A, label: "Term" },
      { id: B, label: "Fee" },
      { id: C, label: "fee" },
    ];
    const parsed = promptFromDisplay("@{term}, @{Fee} and @{Nope}", columns);
    expect(parsed.prompt).toBe(`@{${A}}, @{Fee} and @{Nope}`);
    expect(parsed.unknown).toEqual(["Nope"]);
    expect(parsed.ambiguous).toEqual(["Fee"]);
  });

  it("leaves an id with no label alone, and names it for the model", () => {
    expect(promptForDisplay(`x @{${A}}`, () => undefined)).toBe(`x @{${A}}`);
    expect(promptForModel(`x @{${A}} y`, () => "Term")).toBe("x [Term] y");
  });
});

describe("dependency graph", () => {
  it("finds the cycle a new reference would close, in flow order", () => {
    // C refers to A, and A refers to C.
    expect(
      findCycle(
        new Map([
          [C, [A]],
          [A, [C]],
        ]),
        C,
      ),
    ).toEqual([A, C]);
    // C refers to B, B to A, A to C.
    expect(
      findCycle(
        new Map([
          [C, [B]],
          [B, [A]],
          [A, [C]],
        ]),
        C,
      ),
    ).toEqual([A, B, C]);
    expect(
      findCycle(
        new Map([
          [C, [A]],
          [A, []],
        ]),
        C,
      ),
    ).toBeNull();
    expect(findCycle(new Map([[C, [C]]]), C)).toEqual([C]);
  });

  it("finds dependents through other columns", () => {
    const edges = new Map([
      [B, [A]],
      [C, [B]],
      [A, []],
    ]);
    expect(dependentsOf(edges, [A]).sort()).toEqual([B, C].sort());
    expect(dependentsOf(edges, [B])).toEqual([C]);
    expect(dependentsOf(edges, [C])).toEqual([]);
  });

  it("orders columns after the ones they use", () => {
    const columns = [
      { id: C, depends_on: [B] },
      { id: B, depends_on: [A] },
      { id: A, depends_on: [] },
    ];
    expect(inRunOrder(columns).map((c) => c.id)).toEqual([A, B, C]);
  });
});
