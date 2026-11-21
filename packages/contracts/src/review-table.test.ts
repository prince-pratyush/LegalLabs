import { describe, expect, it } from "vitest";
import {
  BulkCellsBody,
  CreateColumnBody,
  CreateTableBody,
  DEFAULT_SETTINGS,
  ModelCellOutput,
  PatchCellBody,
  parseColumnOptions,
  parseSort,
  RunColumnBody,
  TableSource,
  ValueTyped,
} from "./review-table.js";

const ID = "019a5b6e-0000-7000-8000-000000000001";

const yesNo = {
  options: [
    { id: "yes", label: "Yes", color: "green" },
    { id: "no", label: "No", color: "red" },
  ],
  allow_other: false,
};

describe("TableSource", () => {
  it("takes a vault, loose uploads or a thread", () => {
    expect(TableSource.parse({ kind: "vault", vault_id: ID }).kind).toBe("vault");
    expect(TableSource.parse({ kind: "uploads", upload_ids: [ID] }).kind).toBe("uploads");
    expect(TableSource.parse({ kind: "thread", thread_id: ID }).kind).toBe("thread");
  });

  it("caps uploads at 50", () => {
    const ids = Array.from({ length: 51 }, () => ID);
    expect(TableSource.safeParse({ kind: "uploads", upload_ids: ids }).success).toBe(false);
  });

  it("refuses unknown keys, so a typo can't widen a source", () => {
    expect(TableSource.safeParse({ kind: "vault", vault_id: ID, vault_ids: [ID] }).success).toBe(
      false,
    );
  });

  it("refuses an empty name", () => {
    expect(
      CreateTableBody.safeParse({ name: "  ", source: { kind: "thread", thread_id: ID } }).success,
    ).toBe(false);
  });
});

describe("column options", () => {
  it("fills defaults per type", () => {
    expect(parseColumnOptions("currency", undefined)).toEqual({
      success: true,
      data: { default_currency: "USD", decimals: 2 },
    });
    expect(parseColumnOptions("free", {})).toEqual({ success: true, data: { max_words: 150 } });
  });

  it("needs 2 to 20 classify options with unique labels", () => {
    expect(parseColumnOptions("classify", { options: [yesNo.options[0]] }).success).toBe(false);
    const twice = { options: [yesNo.options[0], { ...yesNo.options[1], label: "yes" }] };
    expect(parseColumnOptions("classify", twice).success).toBe(false);
    expect(parseColumnOptions("classify", yesNo).success).toBe(true);
  });

  it("refuses options from another type", () => {
    expect(parseColumnOptions("date", { decimals: 2 }).success).toBe(false);
  });

  it("checks options inside a create body", () => {
    const base = { label: "Governing law", prompt: "Which law governs?" };
    expect(CreateColumnBody.safeParse({ ...base, type: "classify", options: {} }).success).toBe(
      false,
    );
    expect(CreateColumnBody.safeParse({ ...base, type: "classify", options: yesNo }).success).toBe(
      true,
    );
  });

  it("lets only manual columns go without a prompt", () => {
    expect(CreateColumnBody.safeParse({ label: "Notes", prompt: "", type: "free" }).success).toBe(
      false,
    );
    expect(CreateColumnBody.safeParse({ label: "Notes", prompt: "", type: "manual" }).success).toBe(
      true,
    );
  });

  it("caps labels at 80 and prompts at 4,000 characters", () => {
    const long = { label: "x".repeat(81), prompt: "p", type: "free" };
    expect(CreateColumnBody.safeParse(long).success).toBe(false);
    const prompt = { label: "x", prompt: "p".repeat(4001), type: "free" };
    expect(CreateColumnBody.safeParse(prompt).success).toBe(false);
  });
});

describe("runs and cells", () => {
  it("defaults a run to every row and leaves verified cells alone", () => {
    expect(RunColumnBody.parse({})).toEqual({
      scope: "all",
      include_verified: false,
      include_dependents: false,
    });
    expect(RunColumnBody.parse({ scope: { row_ids: [ID] } }).scope).toEqual({ row_ids: [ID] });
  });

  it("needs a colour for flag and only for flag", () => {
    expect(BulkCellsBody.safeParse({ cell_ids: [ID], op: "flag" }).success).toBe(false);
    expect(BulkCellsBody.safeParse({ cell_ids: [ID], op: "flag", flag_color: "red" }).success).toBe(
      true,
    );
    expect(BulkCellsBody.safeParse({ cell_ids: [ID], op: "lock", flag_color: "red" }).success).toBe(
      false,
    );
  });

  it("refuses an empty patch", () => {
    expect(PatchCellBody.safeParse({}).success).toBe(false);
  });

  it("keeps money as a decimal string", () => {
    const money = { kind: "currency", amount: "1500000.00", currency: "USD" };
    expect(ValueTyped.parse(money)).toEqual(money);
    expect(ValueTyped.safeParse({ ...money, amount: 1500000 }).success).toBe(false);
  });

  it("reads a sort from the query string", () => {
    expect(parseSort(`${ID}:desc`)).toEqual({ column_id: ID, direction: "desc" });
    expect(parseSort(`${ID}:up`)).toBeNull();
  });

  it("has settings defaults", () => {
    expect(DEFAULT_SETTINGS.date_format).toBe("ISO");
    expect(DEFAULT_SETTINGS.null_display).toBe("—");
  });
});

describe("ModelCellOutput", () => {
  it("accepts what a small model writes, with string pages", () => {
    const out = ModelCellOutput.parse({
      value: "1 March 2024",
      citations: [{ doc: "D1", page: "2", quote: "dated 1 March 2024" }],
    });
    expect(out.citations[0]?.page).toBe(2);
    expect(out.not_found).toBe(false);
    expect(out.reasoning).toBe("");
  });
});
