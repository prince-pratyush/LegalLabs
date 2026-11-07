import { z } from "zod";
import { Id } from "./id.js";

// Stored on the matter, never inferred from rows, so removing rows can only close a matter.
export const WallMode = z.enum(["open", "allow_list"]);
export type WallMode = z.infer<typeof WallMode>;

export const Wall = z.object({
  id: Id,
  matter_id: Id,
  principal_type: z.enum(["user", "group"]),
  principal_id: Id,
  effect: z.enum(["allow", "deny"]),
  provider: z.enum(["internal", "csv", "intapp", "imanage_spm"]),
});
export type Wall = z.infer<typeof Wall>;
