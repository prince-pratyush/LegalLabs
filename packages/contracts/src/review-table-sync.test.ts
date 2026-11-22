import { describe, expect, it } from "vitest";
import { PutSyncBody } from "./review-table-sync.js";
import {
  type ColumnDef,
  instantiatePrompt,
  templateOrder,
  templatizePrompt,
} from "./review-table-template.js";

const F = "0194f3a0-0000-7000-8000-00000000000a";
const col = (key: string, prompt = "p"): ColumnDef => ({
  key,
  label: key,
  type: "free",
  prompt,
  options: {},
});

describe("PutSyncBody", () => {
  it("needs folders for selected_folders and refuses them otherwise", () => {
    expect(PutSyncBody.safeParse({ mode: "entire_vault" }).data).toEqual({
      mode: "entire_vault",
      notify: false,
    });
    expect(PutSyncBody.safeParse({ mode: "selected_folders" }).success).toBe(false);
    expect(PutSyncBody.safeParse({ mode: "selected_folders", folder_ids: [F] }).success).toBe(true);
    expect(PutSyncBody.safeParse({ mode: "off", folder_ids: [F] }).success).toBe(false);
  });
});

describe("template prompts", () => {
  it("swaps column ids for keys and back", () => {
    const saved = templatizePrompt(`Is @{${F}} usual?`, new Map([[F, "c1"]]));
    expect(saved).toBe("Is @{c1} usual?");
    expect(instantiatePrompt(saved, new Map([["c1", F]]))).toBe(`Is @{${F}} usual?`);
  });

  it("orders columns after the ones they use, and refuses a circle", () => {
    expect(templateOrder([col("c2", "uses @{c1}"), col("c1")])?.map((c) => c.key)).toEqual([
      "c1",
      "c2",
    ]);
    expect(templateOrder([col("c1", "@{c2}"), col("c2", "@{c1}")])).toBeNull();
  });
});
