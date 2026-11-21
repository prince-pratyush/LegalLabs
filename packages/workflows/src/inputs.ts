import {
  FileRef,
  type InputBlock,
  isInput,
  topoOrder,
  type WorkflowDefinition,
} from "@legallabs/contracts";
import type { InputValue, RunInputs } from "./ports.js";

export interface InputIssue {
  code:
    | "INPUT_REQUIRED"
    | "INPUT_UNKNOWN"
    | "INPUT_WRONG_TYPE"
    | "INPUT_TOO_MANY_FILES"
    | "INPUT_TOO_FEW_FILES"
    | "INPUT_TOO_LONG"
    | "INPUT_OPTION_UNKNOWN"
    | "INPUT_ONE_OPTION";
  label: string;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The intake form: every input block, in the order the canvas runs them. */
export function intakeForm(def: WorkflowDefinition): InputBlock[] {
  const order = topoOrder(def) ?? def.blocks.map((b) => b.id);
  const byId = new Map(def.blocks.map((b) => [b.id, b]));
  return order.map((id) => byId.get(id)).filter((b): b is InputBlock => !!b && isInput(b));
}

/** A form answer by label, ignoring case, as the person's labels and the canvas may differ. */
export function inputFor(inputs: RunInputs, label: string): InputValue | undefined {
  const key = Object.keys(inputs).find((k) => k.toLowerCase() === label.toLowerCase());
  return key === undefined ? undefined : inputs[key];
}

const isEmpty = (v: InputValue | undefined) =>
  v === undefined || (typeof v === "string" ? v.trim() === "" : v.length === 0);

/**
 * Checks a filled form before any run is made (spec §4.10: missing required inputs fail
 * before any step). An empty optional input is fine: it falls back to its default.
 */
export function checkInputs(def: WorkflowDefinition, inputs: RunInputs): InputIssue[] {
  const issues: InputIssue[] = [];
  const form = intakeForm(def);
  const add = (code: InputIssue["code"], label: string, message: string) =>
    issues.push({ code, label, message });
  for (const key of Object.keys(inputs)) {
    if (!form.some((b) => b.label.toLowerCase() === key.toLowerCase())) {
      add("INPUT_UNKNOWN", key, `The workflow has no input "${key}".`);
    }
  }
  for (const block of form) {
    const value = inputFor(inputs, block.label);
    if (isEmpty(value)) {
      const hasDefault =
        (block.type === "user_input.file" && (block.default_files?.length ?? 0) > 0) ||
        (block.type === "user_input.text" && block.default_text !== undefined) ||
        (block.type === "user_input.select" && (block.default_option_ids?.length ?? 0) > 0) ||
        (block.type === "user_input.review_table" && block.default_table_id !== undefined);
      if (
        !block.optional &&
        !hasDefault &&
        !(block.type === "user_input.file" && block.min === 0)
      ) {
        add("INPUT_REQUIRED", block.label, `"${block.label}" is required.`);
      }
      continue;
    }
    switch (block.type) {
      case "user_input.file": {
        const files = Array.isArray(value) ? value : null;
        if (!files || !files.every((f) => FileRef.safeParse(f).success)) {
          add("INPUT_WRONG_TYPE", block.label, `"${block.label}" takes files.`);
          break;
        }
        if (files.length > block.max) {
          add(
            "INPUT_TOO_MANY_FILES",
            block.label,
            `"${block.label}" takes up to ${block.max} files; file ${block.max + 1} was refused.`,
          );
        }
        if (files.length < block.min) {
          add("INPUT_TOO_FEW_FILES", block.label, `"${block.label}" needs ${block.min} files.`);
        }
        break;
      }
      case "user_input.text":
        if (typeof value !== "string") {
          add("INPUT_WRONG_TYPE", block.label, `"${block.label}" takes text.`);
        } else if (value.length > block.max_chars) {
          add(
            "INPUT_TOO_LONG",
            block.label,
            `"${block.label}" takes ${block.max_chars} characters.`,
          );
        }
        break;
      case "user_input.select": {
        const ids: unknown[] = typeof value === "string" ? [value] : (value ?? []);
        if (!ids.every((id) => typeof id === "string")) {
          add("INPUT_WRONG_TYPE", block.label, `"${block.label}" takes option ids.`);
          break;
        }
        const known = new Set(block.options.map((o) => o.id));
        if ((ids as string[]).some((id) => !known.has(id))) {
          add("INPUT_OPTION_UNKNOWN", block.label, `"${block.label}" has no such option.`);
        }
        if (!block.multiple && ids.length > 1) {
          add("INPUT_ONE_OPTION", block.label, `"${block.label}" takes one option.`);
        }
        break;
      }
      case "user_input.review_table":
        if (typeof value !== "string" || !UUID.test(value)) {
          add("INPUT_WRONG_TYPE", block.label, `"${block.label}" takes a review table.`);
        }
        break;
    }
  }
  return issues;
}
