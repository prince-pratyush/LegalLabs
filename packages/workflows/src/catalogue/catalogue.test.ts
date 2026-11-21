import { validateWorkflow, WorkflowDefinition } from "@legallabs/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { checkInputs } from "../inputs.js";
import { runInMemory, scriptedPorts, testFile } from "../testing.js";
import { CATALOGUE, catalogueEntry } from "./index.js";

// The outputs agents-workflows.md §4.11 lists for each, in the Response's order.
const EXPECTED: Record<string, ("message" | "file" | "table")[]> = {
  translate: ["file", "message"],
  proofread: ["file", "message"],
  client_alert: ["file", "message"],
  timeline: ["table", "message"],
  draft_from_template: ["file", "message"],
  redline_changes: ["message", "table"],
  research_memo: ["file", "table"],
  transcript_topics: ["message", "table"],
  discovery_responses: ["table", "file"],
  diligence_insights: ["message", "table"],
  interview_calls: ["message", "table"],
  transcribe: ["file"],
  request_list_check: ["table", "message"],
  ma_deal_points: ["table", "message"],
  court_opinion_review: ["table", "message"],
};

const ran: string[] = [];
afterAll(() => {
  // The exit gate: every pre-built workflow runs on its sample inputs.
  console.log(`catalogue workflows run on sample inputs: ${ran.length}/${CATALOGUE.length}`);
});

describe("the pre-built catalogue", () => {
  it("has the 15 workflows of the spec, with unique keys and titles", () => {
    expect(CATALOGUE).toHaveLength(15);
    expect(new Set(CATALOGUE.map((e) => e.key)).size).toBe(15);
    expect(new Set(CATALOGUE.map((e) => e.title)).size).toBe(15);
    expect(Object.keys(EXPECTED).sort()).toEqual(CATALOGUE.map((e) => e.key).sort());
  });

  it.each(CATALOGUE.map((e) => [e.key, e] as const))("%s is a valid definition", (_key, entry) => {
    expect(WorkflowDefinition.parse(entry.definition)).toEqual(entry.definition);
    expect(validateWorkflow(entry.definition).errors).toEqual([]);
    expect(checkInputs(entry.definition, entry.sample.inputs)).toEqual([]);
  });

  it.each(CATALOGUE.map((e) => [e.key, e] as const))(
    "%s runs to completion on its sample inputs",
    async (key, entry) => {
      const ports = scriptedPorts(
        { definition: entry.definition, inputs: entry.sample.inputs },
        { files: entry.sample.files },
      );
      const r = await runInMemory(ports.deps, { onWait: () => ({ name: "approve_plan" }) });
      expect(r.result).toEqual({ status: "done" });
      expect([...r.steps.values()].every((s) => s.status === "done")).toBe(true);
      expect(ports.artifacts.posted.map((p) => p.kind).filter(dedupeRuns)).toEqual(EXPECTED[key]);
      // Each output is a run event the thread shows.
      expect(r.events.filter((e) => e.type === "output").length).toBe(
        ports.artifacts.posted.length,
      );
      expect(r.run.cost_usd).toBeGreaterThan(0);
      ran.push(key);
    },
  );

  it("Translate refuses an 11th file on the intake form", () => {
    const translate = catalogueEntry("translate");
    if (!translate) throw new Error("missing");
    const eleven = Array.from({ length: 11 }, (_, i) => testFile(`Doc ${i}.docx`));
    const issues = checkInputs(translate.definition, {
      ...translate.sample.inputs,
      Documents: eleven,
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: "INPUT_TOO_MANY_FILES", label: "Documents" }),
    ]);
    expect(issues[0]?.message).toContain("file 11");
    const ten = eleven.slice(0, 10);
    expect(
      checkInputs(translate.definition, { ...translate.sample.inputs, Documents: ten }),
    ).toEqual([]);
  });

  it("translates each file into its own document", async () => {
    const translate = catalogueEntry("translate");
    if (!translate) throw new Error("missing");
    const ports = scriptedPorts(
      { definition: translate.definition, inputs: translate.sample.inputs },
      { files: translate.sample.files },
    );
    await runInMemory(ports.deps);
    expect(ports.drafts.calls.map((c) => c.base?.name)).toEqual(translate.sample.files);
    expect(ports.drafts.calls[0]?.instructions).toContain("into French");
    expect(ports.artifacts.posted.filter((p) => p.kind === "file")).toHaveLength(2);
  });
});

// One file per translated or transcribed document: compare kinds, not counts.
function dedupeRuns(kind: string, i: number, all: string[]) {
  return i === 0 || all[i - 1] !== kind;
}
