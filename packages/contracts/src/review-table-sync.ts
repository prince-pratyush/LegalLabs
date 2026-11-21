import { z } from "zod";
import { Id } from "./id.js";

export const SyncMode = z.enum(["off", "entire_vault", "selected_folders"]);
export type SyncMode = z.infer<typeof SyncMode>;

/** Turn vault sync on, change what it covers, or turn it off. */
export const PutSyncBody = z
  .object({
    mode: SyncMode,
    folder_ids: z.array(Id).min(1).max(100).optional(),
    /** Tell the owner when a pass adds rows (the `table.sync_added_rows` notification). */
    notify: z.boolean().default(false),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.mode === "selected_folders" && !body.folder_ids) {
      ctx.addIssue({ code: "custom", path: ["folder_ids"], message: "Choose the folders to sync" });
    }
    if (body.mode !== "selected_folders" && body.folder_ids) {
      ctx.addIssue({
        code: "custom",
        path: ["folder_ids"],
        message: "Folders only apply to selected_folders",
      });
    }
  });
export type PutSyncBody = z.infer<typeof PutSyncBody>;

/** pending while rows sync added are still waiting for or running their columns. */
export const SyncState = z.enum(["off", "idle", "pending"]);
export type SyncState = z.infer<typeof SyncState>;

export const SyncStatus = z.object({
  mode: SyncMode,
  folder_ids: z.array(Id).nullable(),
  notify: z.boolean(),
  state: SyncState,
  pending_rows: z.number().int(),
  /** Rows whose file has left the vault; they keep their cells but can't be re-run. */
  removed_rows: z.number().int(),
  last_synced_at: z.string().nullable(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

/** What one pass did. */
export const SyncResult = z.object({
  added_rows: z.number().int(),
  /** Of those rows, how many are a newer version of a file already in the table. */
  new_versions: z.number().int(),
  removed_rows: z.number().int(),
  restored_rows: z.number().int(),
  /** Column runs started on the new rows. */
  runs: z.number().int(),
});
export type SyncResult = z.infer<typeof SyncResult>;
