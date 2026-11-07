import { z } from "zod";

// Version 7 puts the creation time first, so IDs sort in the order rows were made.
export const Id = z.uuid({ version: "v7" });
export type Id = z.infer<typeof Id>;
