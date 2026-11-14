import type { UploadItem } from "@legallabs/ui";
import { ApiError } from "../api.js";
import { failureText, REJECTIONS, vaultApi } from "./api.js";

export interface Picked {
  file: File;
  /** The folders above the file inside a dropped or chosen folder, if any. */
  relativePath?: string;
}

// The server reads two uploads at a time; a third waits and retries.
const PARALLEL = 3;
const BUSY_RETRY_MS = 1500;

const folderOf = (file: File) => {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : undefined;
};

export const pick = (files: Iterable<File>): Picked[] =>
  [...files].map((file) => {
    const relativePath = folderOf(file);
    return relativePath ? { file, relativePath } : { file };
  });

/**
 * Checks every file against the limits first, so nothing refused is ever sent, then uploads
 * the rest a few at a time. `update` is called with each change to a file's state.
 */
export async function uploadAll(
  vaultId: string,
  folderId: string | null,
  picked: readonly Picked[],
  update: (id: string, change: Partial<UploadItem> & { fileId?: string }) => void,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const refs = picked.map((_, i) => String(i));
  const { rejected } = await vaultApi.preflight(
    vaultId,
    picked.map((p, i) => ({ client_ref: refs[i] ?? "", name: p.file.name, size: p.file.size })),
  );
  const refused = new Set(rejected.map((r) => r.client_ref));
  for (const r of rejected)
    update(r.client_ref, { state: "rejected", message: REJECTIONS[r.reason] });

  const queue = picked
    .map((p, i) => ({ p, ref: refs[i] ?? "" }))
    .filter((q) => !refused.has(q.ref));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { p, ref } = next;
      update(ref, { state: "uploading", progress: 0 });
      for (;;) {
        try {
          const file = await vaultApi.upload(vaultId, p.file, folderId, p.relativePath);
          update(ref, {
            state: file.state,
            fileId: file.id,
            ...(file.state === "failed" ? { message: failureText(file.failure_reason) } : {}),
          });
          break;
        } catch (err) {
          if (err instanceof ApiError && err.status === 503) {
            await sleep(BUSY_RETRY_MS);
            continue;
          }
          update(ref, {
            state: "rejected",
            message: err instanceof ApiError ? err.message : "The upload didn't finish.",
          });
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}
