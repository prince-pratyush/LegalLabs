// Plain numbers only: the Temporal workflow bundle imports this file and nothing else heavy.
const HOUR = 3_600_000;
export const TIMEOUT_MS = {
  approval: 7 * 24 * HOUR,
  input: 72 * HOUR,
  paused: 7 * 24 * HOUR,
  agent: 6 * HOUR,
  workflow: 24 * HOUR,
} as const;
export const MAX_STEPS = 200;
export const STEP_TIMEOUT_MINUTES = 15;
export const STEP_ATTEMPTS = 3;
