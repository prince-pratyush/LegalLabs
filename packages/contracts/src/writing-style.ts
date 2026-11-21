import { z } from "zod";
import { Id } from "./id.js";

/** Limits for writing styles (spec 3.5, 4.5). */
export const STYLE_LIMITS = {
  perUser: 50,
  name: 80,
  instructions: 5000,
  derived: 2000,
  samplePages: 20,
  sampleChars: 50_000,
  /** How much of the sample goes into a prompt as a few-shot excerpt. */
  excerptChars: 3000,
} as const;

const noNul = (text: string) => !text.includes("\0");
const text = (max: number) => z.string().trim().max(max).refine(noNul, "no NUL bytes");

export const StyleKind = z.enum(["instructions", "sample"]);
export type StyleKind = z.infer<typeof StyleKind>;

export const StyleStatus = z.enum(["processing", "ready", "failed"]);
export type StyleStatus = z.infer<typeof StyleStatus>;

export const StyleName = text(STYLE_LIMITS.name).pipe(z.string().min(1));
export const StyleInstructions = text(STYLE_LIMITS.instructions).pipe(z.string().min(1));

export const StylePatch = z
  .object({
    name: StyleName.optional(),
    instructions: StyleInstructions.optional(),
    derived_instructions: text(STYLE_LIMITS.derived).pipe(z.string().min(1)).optional(),
  })
  .strict();
export type StylePatch = z.infer<typeof StylePatch>;

export const StyleShare = z.object({ shared: z.boolean() }).strict();

export const WritingStyle = z.object({
  id: Id,
  name: z.string(),
  owner_id: Id,
  owner_name: z.string().optional(),
  kind: StyleKind,
  instructions: z.string().nullable(),
  derived_instructions: z.string().nullable(),
  sample: z.object({ pages: z.number().int(), chars: z.number().int() }).nullable(),
  shared: z.boolean(),
  status: StyleStatus,
  /** False for someone else's shared style: it can be selected, not changed. */
  editable: z.boolean(),
  updated_at: z.string(),
});
export type WritingStyle = z.infer<typeof WritingStyle>;

export const WritingStyleList = z.object({
  mine: z.array(WritingStyle),
  workspace: z.array(WritingStyle),
});
export type WritingStyleList = z.infer<typeof WritingStyleList>;
