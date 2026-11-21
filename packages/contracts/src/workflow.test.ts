import { describe, expect, it } from "vitest";
import { type Block, findRefs, topoOrder, validateWorkflow, WorkflowDefinition } from "./index.js";

const DOC = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";

type Ai = Extract<Block, { type: "ai_action" }>;
type In = Extract<Block, { type: "user_input.file" }>;
const file = (): In => ({
  type: "user_input.file",
  id: "in",
  label: "Contract",
  prompt: "Upload",
  min: 1,
  max: 5,
  optional: false,
});
const summary = (prompt = "Summarise @Contract"): Ai => ({
  type: "ai_action",
  id: "sum",
  label: "Summary",
  prompt,
  context: [],
  sources: [],
  model: "auto",
  deep_analysis: false,
  output: "markdown",
  response_mode: "auto",
});
const response = (ref = "@Summary"): Block => ({
  type: "response",
  id: "out",
  outputs: [{ ref, as: "message" }],
  allow_follow_ups: true,
});

const make = (blocks: Block[], edges: [string, string][], embedded = false) =>
  WorkflowDefinition.parse({
    schema: "counsel.workflow/1",
    blocks,
    edges: edges.map(([from, to]) => ({ from, to })),
    embedded_files: embedded ? [{ document_id: DOC, label: "Terms" }] : [],
  });

const codes = (def: ReturnType<typeof make>) => validateWorkflow(def).errors.map((e) => e.code);
const base = () =>
  make(
    [file(), summary(), response()],
    [
      ["in", "sum"],
      ["sum", "out"],
    ],
  );

describe("validateWorkflow", () => {
  it("accepts a simple chain", () => {
    expect(validateWorkflow(base())).toEqual({ errors: [], warnings: [] });
    expect(topoOrder(base())).toEqual(["in", "sum", "out"]);
  });

  it("needs an input at every root", () => {
    const def = make([summary("Say hi"), response()], [["sum", "out"]]);
    expect(codes(def)).toContain("WF_NO_INPUT_START");
  });

  it("needs exactly one response, last", () => {
    expect(codes(make([file(), summary()], [["in", "sum"]]))).toContain("WF_RESPONSE_REQUIRED");
    expect(
      codes(
        make(
          [file(), response(), summary()],
          [
            ["in", "out"],
            ["out", "sum"],
          ],
        ),
      ),
    ).toContain("WF_RESPONSE_REQUIRED");
  });

  it("rejects cycles", () => {
    const def = make(
      [file(), summary(), { ...summary("Again @Summary"), id: "two", label: "Two" }, response()],
      [
        ["in", "sum"],
        ["sum", "two"],
        ["two", "sum"],
        ["two", "out"],
      ],
    );
    expect(codes(def)).toContain("WF_CYCLE");
  });

  it("finds a block that nothing leads to", () => {
    const def = make(
      [
        file(),
        summary(),
        { ...summary("Loop @Four"), id: "three", label: "Three" },
        { ...summary("Loop @Three"), id: "four", label: "Four" },
        response(),
      ],
      [
        ["in", "sum"],
        ["sum", "out"],
        ["three", "four"],
        ["four", "three"],
      ],
    );
    expect(codes(def)).toContain("WF_UNREACHABLE");
  });

  it("rejects duplicate labels ignoring case", () => {
    const def = make(
      [file(), summary(), { ...summary("x"), id: "s2", label: "summary" }, response()],
      [
        ["in", "sum"],
        ["in", "s2"],
        ["sum", "out"],
        ["s2", "out"],
      ],
    );
    expect(codes(def)).toContain("WF_LABEL_DUP");
  });

  it("rejects an unknown reference and one that is not upstream", () => {
    expect(
      codes(
        make(
          [file(), summary("Use @Nothing"), response()],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
        ),
      ),
    ).toContain("WF_REF_UNKNOWN");
    const sibling = { ...summary("Use @Summary"), id: "b", label: "Other" };
    const def = make(
      [file(), summary(), sibling, response()],
      [
        ["in", "sum"],
        ["in", "b"],
        ["sum", "out"],
        ["b", "out"],
      ],
    );
    expect(codes(def)).toContain("WF_REF_NOT_UPSTREAM");
  });

  it("ignores an email address in a prompt", () => {
    const def = make(
      [file(), summary("Mail a@b.com about @Contract"), response()],
      [
        ["in", "sum"],
        ["sum", "out"],
      ],
    );
    expect(codes(def)).toEqual([]);
  });

  it("checks conditionals against their selection", () => {
    const select: Block = {
      type: "user_input.select",
      id: "sel",
      label: "Mode",
      prompt: "Pick",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      multiple: true,
      optional: false,
    };
    const cond = (on: string, branches: { option_ids: string[]; to: string }[]): Block => ({
      type: "logic.conditional",
      id: "c",
      label: "Branch",
      on,
      branches,
    });
    const ok = make(
      [file(), select, cond("@Mode", [{ option_ids: ["a"], to: "sum" }]), summary(), response()],
      [
        ["in", "c"],
        ["sel", "c"],
        ["c", "sum"],
        ["sum", "out"],
      ],
    );
    expect(validateWorkflow(ok).errors).toEqual([]);

    const notSelect = make(
      [
        file(),
        select,
        cond("@Contract", [{ option_ids: ["a"], to: "sum" }]),
        summary(),
        response(),
      ],
      [
        ["in", "c"],
        ["sel", "c"],
        ["c", "sum"],
        ["sum", "out"],
      ],
    );
    expect(codes(notSelect)).toContain("WF_COND_NOT_SELECT");

    const bad = make(
      [
        file(),
        select,
        cond("@Mode", [
          { option_ids: ["a", "zz"], to: "out" },
          { option_ids: ["a"], to: "sum" },
        ]),
        summary(),
        response(),
      ],
      [
        ["in", "c"],
        ["sel", "c"],
        ["c", "sum"],
        ["sum", "out"],
      ],
    );
    expect(codes(bad)).toEqual(
      expect.arrayContaining(["WF_COND_OPTION_UNKNOWN", "WF_COND_TARGET"]),
    );
  });

  it("limits sources, uploads and embedded files", () => {
    const three = {
      ...summary(),
      sources: [1, 2, 3].map((n) => ({ kind: "knowledge_source" as const, source: `s${n}` })),
    };
    expect(
      codes(
        make(
          [file(), three, response()],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
        ),
      ),
    ).toContain("WF_SOURCES_MAX");
    expect(
      codes(
        make(
          [{ ...file(), max: 51 } as Block, summary(), response()],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
        ),
      ),
    ).toContain("WF_UPLOAD_MAX");
    const upload = { ...summary(), context: [{ kind: "upload" as const, ref: DOC }] };
    expect(
      codes(
        make(
          [file(), upload, response()],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
        ),
      ),
    ).toContain("WF_EMBEDDED_MAX");
    expect(
      codes(
        make(
          [file(), upload, response()],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
          true,
        ),
      ),
    ).toEqual([]);
  });

  it("checks drafting, json, models and output kinds", () => {
    const draft: Block = {
      type: "drafting",
      id: "d",
      label: "Letter",
      format: "pptx",
      mode: "edit_file",
      instructions: "x",
      context: [],
      track_changes: true,
    };
    const def = make(
      [file(), draft, response("@Letter")],
      [
        ["in", "d"],
        ["d", "out"],
      ],
    );
    const result = validateWorkflow(def);
    expect(result.errors.map((e) => e.code)).toContain("WF_DRAFT_BASE");
    expect(result.warnings.map((w) => w.code)).toContain("WF_TRACK_CHANGES_COERCED");

    const json = { ...summary(), output: "json" as const };
    expect(
      codes(
        make(
          [file(), json, response()],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
        ),
      ),
    ).toContain("WF_JSON_SCHEMA");

    const model = { ...summary(), model: "p/x" };
    const withModel = make(
      [file(), model, response()],
      [
        ["in", "sum"],
        ["sum", "out"],
      ],
    );
    expect(
      validateWorkflow(withModel, { allowedModels: ["q/y"] }).errors.map((e) => e.code),
    ).toContain("WF_MODEL_NOT_ALLOWED");
    expect(validateWorkflow(withModel).errors).toEqual([]);

    const asFile: Block = {
      type: "response",
      id: "out",
      outputs: [{ ref: "@Summary", as: "file" }],
      allow_follow_ups: true,
    };
    expect(
      codes(
        make(
          [file(), summary(), asFile],
          [
            ["in", "sum"],
            ["sum", "out"],
          ],
        ),
      ),
    ).toContain("WF_OUTPUT_REF_KIND");
  });

  it("warns about many AI blocks and optional inputs without defaults", () => {
    const many: Block[] = Array.from({ length: 11 }, (_, i) => ({
      ...summary(),
      id: `s${i}`,
      label: `S${i}`,
    }));
    const def = make(
      [{ ...file(), optional: true }, ...many, response("@S0")],
      [
        ...many.map((b): [string, string] => ["in", b.id]),
        ...many.map((b): [string, string] => [b.id, "out"]),
      ],
    );
    const warnings = validateWorkflow(def).warnings.map((w) => w.code);
    expect(warnings).toEqual(
      expect.arrayContaining(["WF_MANY_AI_BLOCKS", "WF_OPTIONAL_NO_DEFAULT"]),
    );
  });
});

describe("findRefs", () => {
  it("prefers the longest label and reports unknown tokens", () => {
    const refs = findRefs("See @Deal Summary and @Deal then @Nope.", ["Deal", "Deal Summary"]);
    expect(refs.map((r) => r.label)).toEqual(["Deal Summary", "Deal", null]);
  });
});
