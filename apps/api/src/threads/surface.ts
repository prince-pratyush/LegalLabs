import type { Principal } from "../auth/auth.js";

export const surfaceOf = (via: Principal["via"]) =>
  via === "word" || via === "outlook"
    ? ({ surface: via, accessPoint: via } as const)
    : ({ surface: "web", accessPoint: via ?? "web" } as const);
