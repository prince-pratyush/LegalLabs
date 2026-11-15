import { z } from "zod";

const ids = (max: number) => z.array(z.uuid()).min(1).max(max);

/**
 * Narrows a search. Each list given narrows further (all must hold); a folder includes its
 * subfolders. Walls and the recycle bin apply whatever the scope says.
 */
export const RetrievalScope = z
  .object({
    vault_ids: ids(20).optional(),
    folder_ids: ids(100).optional(),
    document_ids: ids(100).optional(),
  })
  .strict();
export type RetrievalScope = z.infer<typeof RetrievalScope>;
