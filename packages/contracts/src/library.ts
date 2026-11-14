import { z } from "zod";
import { Id } from "./id.js";
import type { Caller } from "./thread.js";

/** Per-item limits; prompts carry no files, so they stay small. */
export const LIBRARY_LIMITS = {
  name: 120,
  description: 500,
  promptText: 8000,
  instructions: 4000,
  /** A letterhead is a few hundred KB; this leaves room for logos. */
  templateBytes: 10 * 1024 * 1024,
  versionNote: 500,
  grants: 100,
  variables: 20,
} as const;

const noNul = (text: string) => !text.includes("\0");
const text = (max: number) => z.string().trim().max(max).refine(noNul, "no NUL bytes");

/** `use` lets someone run a prompt or export through a template; `edit` lets them change it. */
export const LibraryLevel = z.enum(["use", "edit"]);
export type LibraryLevel = z.infer<typeof LibraryLevel>;

export const LibraryGrant = z.object({
  principal_type: z.enum(["user", "group", "workspace"]),
  principal_id: Id,
  level: LibraryLevel,
});
export type LibraryGrant = z.infer<typeof LibraryGrant>;

export const PromptInput = z.object({
  name: text(LIBRARY_LIMITS.name).pipe(z.string().min(1)),
  text: text(LIBRARY_LIMITS.promptText).pipe(z.string().min(1)),
  description: text(LIBRARY_LIMITS.description).optional(),
});
export type PromptInput = z.infer<typeof PromptInput>;

export const TemplateFields = z.object({
  name: text(LIBRARY_LIMITS.name).pipe(z.string().min(1)),
  description: text(LIBRARY_LIMITS.description).optional(),
  instructions: text(LIBRARY_LIMITS.instructions).optional(),
});
export type TemplateFields = z.infer<typeof TemplateFields>;

export const ExportFormat = z.enum(["docx", "pdf"]);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** A template id, the workspace default, or no template at all. */
export const TemplateChoice = z.union([Id, z.enum(["default", "none"])]);
export type TemplateChoice = z.infer<typeof TemplateChoice>;

export interface ResolvedTemplate {
  templateId: string;
  versionId: string;
  versionNo: number;
  name: string;
  bytes: Uint8Array;
}

/** How drafting finds the template to export through; walls and shares are applied. */
export interface TemplatePort {
  resolve(caller: Caller, choice: TemplateChoice): Promise<ResolvedTemplate | null>;
}

// `{{ party name }}`: letters, digits, spaces, `_` and `-`, up to 40 characters.
const VARIABLE = /\{\{\s*([\p{L}\p{N}_][\p{L}\p{N} _-]{0,39}?)\s*\}\}/gu;

/** The distinct variables in a saved prompt, in the order they first appear. */
export function promptVariables(prompt: string): string[] {
  const names: string[] = [];
  for (const m of prompt.matchAll(VARIABLE)) {
    const name = (m[1] ?? "").replace(/\s+/g, " ");
    if (!names.includes(name)) names.push(name);
    if (names.length === LIBRARY_LIMITS.variables) break;
  }
  return names;
}

/** Fills the variables that have a value; the rest stay as `{{name}}` for the user to see. */
export function fillPrompt(prompt: string, values: Readonly<Record<string, string>>): string {
  return prompt.replace(VARIABLE, (whole, raw: string) => {
    const value = values[raw.replace(/\s+/g, " ")]?.trim();
    return value ? value : whole;
  });
}
