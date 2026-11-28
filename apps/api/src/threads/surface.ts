import type { Principal } from "../auth/auth.js";

export const surfaceOf = (via: Principal["via"]) =>
  via === "word"
    ? ({ surface: "word", accessPoint: "word" } as const)
    : ({ surface: "web", accessPoint: via ?? "web" } as const);
