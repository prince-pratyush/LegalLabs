import { z } from "zod";

/** The files a thread can make. */
export const FileFormat = z.enum(["docx", "xlsx"]);
export type FileFormat = z.infer<typeof FileFormat>;
