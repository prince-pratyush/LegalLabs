import { WorkflowDefinition } from "@legallabs/contracts";
import type { z } from "zod";
import { sampleFile } from "../ids.js";
import type { RunInputs } from "../ports.js";

export type Category = "General" | "Transactional" | "Litigation" | "Financial services";

export interface CatalogueEntry {
  /** Stable across releases: the seeder finds a workspace's copy by it. */
  key: string;
  title: string;
  description: string;
  category: Category;
  definition: WorkflowDefinition;
  /** Inputs a run can be tried on, with the names of the files they point at. */
  sample: { inputs: RunInputs; files: string[] };
}

type BlockInput = z.input<typeof WorkflowDefinition>["blocks"][number];

/** A definition with the schema's defaults filled in; edges as [from, to] pairs. */
export function workflow(blocks: BlockInput[], edges: [string, string][]): WorkflowDefinition {
  return WorkflowDefinition.parse({
    schema: "counsel.workflow/1",
    blocks,
    edges: edges.map(([from, to]) => ({ from, to })),
    embedded_files: [],
  });
}

/** Sample uploads: the inputs' file refs and the names a test registers for them. */
export function files(...names: string[]) {
  return { refs: names.map(sampleFile), names };
}

export const numbered = (stem: string, n: number, ext: string) =>
  Array.from({ length: n }, (_, i) => `${stem} ${i + 1}.${ext}`);

export const sample = (inputs: RunInputs, ...groups: { names: string[] }[]) => ({
  inputs,
  files: groups.flatMap((g) => g.names),
});
