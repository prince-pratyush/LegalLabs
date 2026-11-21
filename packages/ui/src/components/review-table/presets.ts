import type { ColumnType } from "./types.js";

// Friendly column presets mapped onto the spec's column types.
export const PRESETS = [
  { id: "text", name: "Text", type: "free", hint: "A short answer in words" },
  { id: "date", name: "Date", type: "date", hint: "A date, or just a month or year" },
  { id: "money", name: "Money", type: "currency", hint: "An amount and its currency" },
  { id: "number", name: "Number", type: "number", hint: "A count, rate or other figure" },
  { id: "yesno", name: "Yes/No", type: "classify", hint: "Yes or No, with the reason" },
  { id: "list", name: "List", type: "classify", hint: "One or more labels you choose" },
  { id: "clause", name: "Clause", type: "verbatim", hint: "The exact words from the document" },
  { id: "manual", name: "Manual", type: "manual", hint: "You type the value; no AI run" },
] as const satisfies readonly { id: string; name: string; type: ColumnType; hint: string }[];

export type PresetId = (typeof PRESETS)[number]["id"];

export interface NewColumn {
  label: string;
  type: ColumnType;
  prompt: string;
  options: Record<string, unknown>;
}

const LIST_COLORS = ["blue", "green", "orange", "purple", "red", "yellow", "teal", "gray"];

/** Option ids must be short and plain; labels can be anything. */
const optionId = (label: string, i: number) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32) || `option_${i + 1}`;

export function listOptions(labels: readonly string[]) {
  const seen = new Set<string>();
  return labels
    .map((label) => label.trim())
    .filter((label) => label && !seen.has(label.toLowerCase()) && seen.add(label.toLowerCase()))
    .map((label, i) => ({
      id: optionId(label, i),
      label,
      color: LIST_COLORS[i % LIST_COLORS.length],
    }));
}

/** The create-column body a preset makes; options satisfy the type's schema. */
export function presetColumn(
  preset: PresetId,
  label: string,
  prompt: string,
  listLabels: readonly string[] = [],
): NewColumn {
  const base = { label: label.trim(), prompt: prompt.trim() };
  switch (preset) {
    case "yesno":
      return {
        ...base,
        type: "classify",
        options: {
          options: [
            { id: "yes", label: "Yes", color: "green" },
            { id: "no", label: "No", color: "red" },
          ],
          allow_multiple: false,
          allow_other: false,
        },
      };
    case "list":
      return {
        ...base,
        type: "classify",
        options: { options: listOptions(listLabels), allow_multiple: true, allow_other: true },
      };
    case "manual":
      return { ...base, type: "manual", options: { input_type: "free" } };
    default: {
      const type = PRESETS.find((p) => p.id === preset)?.type ?? "free";
      return { ...base, type, options: {} };
    }
  }
}

/** Why a new column can't be saved yet, or null when it can. */
export function columnProblem(preset: PresetId, label: string, prompt: string, list: string[]) {
  if (!label.trim()) return "Name the column.";
  if (label.trim().length > 80) return "Keep the name to 80 characters.";
  if (preset !== "manual" && !prompt.trim()) return "Say what to look for.";
  if (prompt.length > 4000) return "Keep the prompt to 4,000 characters.";
  if (preset === "list" && listOptions(list).length < 2) return "Give at least two labels.";
  if (preset === "list" && listOptions(list).length > 20) return "Use 20 labels or fewer.";
  return null;
}

export const TYPE_NAMES: Record<ColumnType, string> = {
  free: "Text",
  date: "Date",
  currency: "Money",
  number: "Number",
  classify: "List",
  verbatim: "Clause",
  manual: "Manual",
};
