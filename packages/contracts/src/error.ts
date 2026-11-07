import { z } from "zod";

// Clients branch on `code`, so it is a stable constant; `message` is for people.
export const ErrorBody = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
