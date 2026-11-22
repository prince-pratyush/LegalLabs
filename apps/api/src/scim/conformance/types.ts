// UNVERIFIED against real Okta or Microsoft Entra ID. Fixtures are written from the vendors'
// public documentation; no real tenant was available. Treat a pass as "matches our reading of
// the docs", not as certification.

/** A matcher: a literal for equality, or one of the operators below. */
export type Expected =
  | string
  | number
  | boolean
  | null
  | { $exists: true }
  | { $absent: true }
  | { $re: string }
  | { $len: number }
  | { $gte: number };

export interface Step {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** May hold {{variables}} saved by earlier steps; {{n}} is unique to the scenario. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
  /** Dot paths into the answer (array indexes allowed) and what they must hold. */
  match?: Record<string, Expected>;
  /** Variable name to dot path in the answer, kept for later steps. */
  save?: Record<string, string>;
}

export interface Scenario {
  name: string;
  /** Where in the vendor's documentation the behaviour is described. */
  source: string;
  /** Workspace settings for the run; a tiny test workspace would otherwise trip the delete guard. */
  settings?: Record<string, unknown>;
  steps: Step[];
}
