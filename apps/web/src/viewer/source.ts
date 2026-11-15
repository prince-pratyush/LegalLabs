import {
  DocumentHit,
  MAX_LAYOUT_PAGES,
  PageLayout,
  RenderManifest,
  viewerPaths,
} from "@legallabs/contracts";
import type { ViewerSource } from "@legallabs/ui";
import { ApiError } from "../api.js";

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.code ?? "UNKNOWN", body?.message ?? "");
  return body;
}

const field = (body: unknown, name: string) => (body as Record<string, unknown> | null)?.[name];

/** The viewer's data for one version, checked against the contract as it arrives. */
export function apiSource(documentId: string, versionId: string): ViewerSource {
  return {
    file: viewerPaths.file(documentId, versionId),
    manifest: async () =>
      RenderManifest.parse(await getJson(viewerPaths.manifest(documentId, versionId))),
    pages: async (from, to) =>
      PageLayout.array().parse(
        field(
          await getJson(
            viewerPaths.pages(
              documentId,
              versionId,
              from,
              Math.min(to, from + MAX_LAYOUT_PAGES - 1),
            ),
          ),
          "pages",
        ),
      ),
    search: async (query) =>
      DocumentHit.array().parse(
        field(await getJson(viewerPaths.search(documentId, versionId, query)), "hits"),
      ),
  };
}
