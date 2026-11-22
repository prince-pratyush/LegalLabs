import { createHash } from "node:crypto";
import type { FileRef } from "@legallabs/contracts";

/** A uuid-shaped id that is the same for the same seed, for sample and test files. */
export function stableId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An uploaded file's reference, stable for a name. */
export const sampleFile = (name: string): FileRef => ({
  kind: "upload",
  ref: stableId(`file:${name}`),
});
