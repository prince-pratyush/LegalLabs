import { ContentControls, FileState, RetentionHours, VaultGrant } from "@legallabs/contracts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { MAX_FILE_BYTES, type UploadResult } from "../documents/documents.js";
import type {
  BinItem,
  Folder,
  Refusal,
  Tree,
  Vault,
  VaultFile,
  VaultStats,
  Vaults,
} from "./vaults.js";

type Env = { Variables: { principal: Principal } };

const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;
const MAX_CONCURRENT_UPLOADS = 2;
const MAX_MANIFEST = 5000;
const MAX_BATCH = 1000;

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes("\0"), "Postgres text cannot hold a NUL byte");

// Control characters have no place in a name shown in lists and logs.
const name = (max: number) => text(1, max).regex(/^[^\p{C}\p{Zl}\p{Zp}/\\]+$/u);
const path = text(1, 2000).regex(/^[^\p{C}\p{Zl}\p{Zp}\\]+$/u);

const createBody = z.object({
  name: name(200),
  description: text(0, 2000).optional(),
  matter_id: z.uuid().nullable().optional(),
});
const patchBody = z
  .object({
    name: name(200).optional(),
    description: text(0, 2000).optional(),
    retention_hours: RetentionHours.optional(),
    content_controls: ContentControls.optional(),
  })
  .strict();
const folderBody = z.object({ name: name(255), parent_id: z.uuid().nullable().optional() });
const folderPatch = z
  .object({ name: name(255).optional(), parent_id: z.uuid().nullable().optional() })
  .strict();
const filePatch = z
  .object({ name: name(255).optional(), folder_id: z.uuid().nullable().optional() })
  .strict();
const itemsBody = z.object({
  document_ids: z.array(z.uuid()).max(MAX_BATCH).default([]),
  folder_ids: z.array(z.uuid()).max(MAX_BATCH).default([]),
});
const sharesBody = z.object({
  grants: z.array(VaultGrant).max(500),
  workspace_view: z.boolean(),
});
const manifestBody = z.object({
  files: z
    .array(
      z.object({
        client_ref: text(1, 200),
        name: name(255),
        size: z.number().int().min(0),
        relative_path: path.optional(),
      }),
    )
    .min(1)
    .max(MAX_MANIFEST),
});
const treeQuery = z.object({
  folder_id: z.uuid().optional(),
  cursor: text(1, 2000).optional(),
  q: text(1, 200).optional(),
  state: FileState.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const REFUSALS: Record<Refusal, { status: 403 | 404 | 409; message: string }> = {
  NOT_FOUND: { status: 404, message: "That wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have permission to do that in this vault." },
  CONFLICT: { status: 409, message: "That would put a folder inside itself or clash with a name." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
};

const UPLOAD_FAILURES: Record<
  Extract<UploadResult, { ok: false }>["reason"] | "NOT_FOUND",
  { status: 403 | 404 | 409 | 413 | 415; message: string }
> = {
  NOT_FOUND: { status: 404, message: "That vault or folder wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have permission to add files to this vault." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
  FILE_TOO_LARGE: { status: 413, message: "The file is larger than the limit for its type." },
  UNSUPPORTED_TYPE: {
    status: 415,
    message: "Only PDF, Word, Excel, email, TXT and Markdown files can be read.",
  },
  VAULT_FILE_LIMIT: { status: 409, message: "The vault already holds as many files as it can." },
  VAULT_SIZE_LIMIT: { status: 409, message: "The vault is full." },
};

export const vaultJson = (vault: Vault) => ({
  id: vault.id,
  name: vault.name,
  description: vault.description,
  matter_id: vault.matterId,
  owner_id: vault.ownerId,
  my_access: vault.access,
  content_controls: vault.contentControls,
  retention_hours: vault.retentionHours,
  created_at: vault.createdAt,
  updated_at: vault.updatedAt,
  deleted_at: vault.deletedAt,
});

const statsJson = (stats: VaultStats) => ({
  files: stats.files,
  bytes: stats.bytes,
  hidden: stats.hidden,
  queued: stats.queued,
  processing: stats.processing,
  ready: stats.ready,
  failed: stats.failed,
  max_files: stats.maxFiles,
  max_bytes: stats.maxBytes,
});

const folderJson = (folder: Folder) => ({
  id: folder.id,
  name: folder.name,
  parent_id: folder.parentId,
});

const fileJson = (file: VaultFile) => ({
  id: file.id,
  version_id: file.versionId,
  folder_id: file.folderId,
  name: file.name,
  mime: file.mime,
  size: file.size,
  state: file.state,
  failure_reason: file.failureReason,
  page_count: file.pageCount,
  updated_at: file.updatedAt,
});

const treeJson = (tree: Tree) => ({
  path: tree.path.map(folderJson),
  folders: tree.folders.map(folderJson),
  files: tree.files.map(fileJson),
  next_cursor: tree.nextCursor,
});

const binJson = (item: BinItem) => ({
  kind: item.kind,
  id: item.id,
  name: item.name,
  deleted_at: item.deletedAt,
  deleted_reason: item.deletedReason,
  purge_at: item.purgeAt,
});

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the request and try again." }, 400);
const notFound = (c: Context) => c.json({ code: "NOT_FOUND", message: "That wasn't found." }, 404);
const refused = (c: Context, reason: Refusal) =>
  c.json({ code: reason, message: REFUSALS[reason].message }, REFUSALS[reason].status);

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export function vaultRoutes(vaults: Vaults, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  let uploading = 0;
  const small = bodyLimit({ maxSize: 256 * 1024 });
  const manifest = bodyLimit({ maxSize: 2 * 1024 * 1024 });

  // Runs before the body is read, so waiting uploads can't pile up in memory.
  const limitUploads: MiddlewareHandler = async (c, next) => {
    if (uploading >= MAX_CONCURRENT_UPLOADS) {
      c.header("Retry-After", "2");
      return c.json({ code: "BUSY", message: "Too many uploads are in progress." }, 503);
    }
    uploading++;
    try {
      await next();
    } finally {
      uploading--;
    }
  };
  const limitFile = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ code: "FILE_TOO_LARGE", message: "The file is too large." }, 413),
  });

  app.post("/", small, async (c) => {
    const input = await body(c, createBody);
    if (!input) return invalid(c);
    const result = await vaults.create(
      c.get("principal"),
      {
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        matterId: input.matter_id ?? null,
      },
      clientOf(c),
    );
    if (!result.ok) return refused(c, result.reason);
    return c.json({ vault: vaultJson(result.value) }, 201);
  });

  app.get("/", async (c) => {
    const found = await vaults.list(c.get("principal"));
    return c.json({ vaults: found.map((v) => ({ ...vaultJson(v), files: v.files })) });
  });

  app.get("/:id", async (c) => {
    const found = await vaults.get(c.get("principal"), c.req.param("id"));
    if (!found) return notFound(c);
    return c.json({ vault: vaultJson(found.vault), stats: statsJson(found.stats) });
  });

  app.patch("/:id", small, async (c) => {
    const input = await body(c, patchBody);
    if (!input || Object.keys(input).length === 0) return invalid(c);
    const result = await vaults.update(
      c.get("principal"),
      c.req.param("id"),
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.retention_hours === undefined ? {} : { retentionHours: input.retention_hours }),
        ...(input.content_controls === undefined
          ? {}
          : { contentControls: input.content_controls }),
      },
      clientOf(c),
    );
    if (!result.ok) return refused(c, result.reason);
    return c.json({ vault: vaultJson(result.value) });
  });

  app.delete("/:id", async (c) => {
    if (!(await vaults.remove(c.get("principal"), c.req.param("id"), clientOf(c)))) {
      return notFound(c);
    }
    return c.body(null, 202);
  });

  app.get("/:id/tree", async (c) => {
    const query = treeQuery.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    const { folder_id, cursor, q, state, limit } = query.data;
    const tree = await vaults.tree(c.get("principal"), c.req.param("id"), {
      folderId: folder_id ?? null,
      cursor: cursor ?? null,
      ...(q === undefined ? {} : { q }),
      ...(state === undefined ? {} : { state }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (!tree) return notFound(c);
    return c.json(treeJson(tree));
  });

  app.post("/:id/folders", small, async (c) => {
    const input = await body(c, folderBody);
    if (!input) return invalid(c);
    const result = await vaults.createFolder(
      c.get("principal"),
      c.req.param("id"),
      { name: input.name, parentId: input.parent_id ?? null },
      clientOf(c),
    );
    if (!result.ok) return refused(c, result.reason);
    return c.json({ folder: folderJson(result.value) }, 201);
  });

  app.patch("/:id/folders/:folderId", small, async (c) => {
    const input = await body(c, folderPatch);
    if (!input || Object.keys(input).length === 0) return invalid(c);
    const result = await vaults.updateFolder(
      c.get("principal"),
      c.req.param("folderId"),
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.parent_id === undefined ? {} : { parentId: input.parent_id }),
      },
      clientOf(c),
    );
    if (!result.ok) return refused(c, result.reason);
    return c.json({ folder: folderJson(result.value) });
  });

  app.patch("/:id/files/:documentId", small, async (c) => {
    const input = await body(c, filePatch);
    if (!input || Object.keys(input).length === 0) return invalid(c);
    const result = await vaults.updateFile(
      c.get("principal"),
      c.req.param("documentId"),
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.folder_id === undefined ? {} : { folderId: input.folder_id }),
      },
      clientOf(c),
    );
    if (!result.ok) return refused(c, result.reason);
    const { id, name: fileName, folderId } = result.value;
    return c.json({ file: { id, name: fileName, folder_id: folderId } });
  });

  for (const action of ["trash", "restore"] as const) {
    app.post(`/:id/${action}`, manifest, async (c) => {
      const input = await body(c, itemsBody);
      if (!input) return invalid(c);
      const count = await vaults[action](
        c.get("principal"),
        c.req.param("id"),
        { documentIds: input.document_ids, folderIds: input.folder_ids },
        clientOf(c),
      );
      if (count === null) return notFound(c);
      return c.json({ items: count });
    });
  }

  app.get("/:id/bin", async (c) => {
    const items = await vaults.bin(c.get("principal"), c.req.param("id"));
    if (!items) return notFound(c);
    return c.json({ items: items.map(binJson) });
  });

  app.get("/:id/shares", async (c) => {
    const shares = await vaults.shares(c.get("principal"), c.req.param("id"));
    if (!shares) return notFound(c);
    return c.json({ grants: shares.grants, workspace_view: shares.workspaceView });
  });

  app.put("/:id/shares", small, async (c) => {
    const input = await body(c, sharesBody);
    if (!input) return invalid(c);
    const result = await vaults.setShares(
      c.get("principal"),
      c.req.param("id"),
      { grants: input.grants, workspaceView: input.workspace_view },
      clientOf(c),
    );
    if (!result) return notFound(c);
    const shares = await vaults.shares(c.get("principal"), c.req.param("id"));
    return c.json({
      grants: shares?.grants ?? [],
      workspace_view: shares?.workspaceView ?? false,
      denied_by_wall: result.deniedByWall,
    });
  });

  app.post("/:id/uploads", manifest, async (c) => {
    const input = await body(c, manifestBody);
    if (!input) return invalid(c);
    const result = await vaults.preflight(
      c.get("principal"),
      c.req.param("id"),
      input.files.map((f) => ({ clientRef: f.client_ref, name: f.name, size: f.size })),
    );
    if (!result) return notFound(c);
    return c.json({
      accepted: result.accepted.map((clientRef) => ({ client_ref: clientRef })),
      rejected: result.rejected.map((r) => ({ client_ref: r.clientRef, reason: r.reason })),
    });
  });

  app.post("/:id/files", limitUploads, limitFile, async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    const folder = form?.folder_id;
    const relative = form?.relative_path;
    if (
      !(file instanceof File) ||
      !name(255).safeParse(file.name).success ||
      (folder !== undefined && !z.uuid().safeParse(folder).success) ||
      (relative !== undefined && !path.safeParse(relative).success)
    ) {
      return invalid(c);
    }
    const result = await vaults.upload(
      c.get("principal"),
      c.req.param("id"),
      {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        folderId: typeof folder === "string" ? folder : null,
        ...(typeof relative === "string" ? { relativePath: relative } : {}),
      },
      clientOf(c),
    );
    if (!result.ok) {
      const { status, message } = UPLOAD_FAILURES[result.reason];
      return c.json({ code: result.reason, message }, status);
    }
    const d = result.document;
    return c.json(
      {
        file: {
          id: d.id,
          version_id: d.versionId,
          name: d.name,
          size: d.size,
          state:
            d.status === "indexed" ? "ready" : d.status === "parsing" ? "processing" : d.status,
          failure_reason: d.failureReason,
        },
      },
      202,
    );
  });

  app.get("/:id/retention/estimate", async (c) => {
    const hours = RetentionHours.safeParse(Number(c.req.query("hours")));
    if (!hours.success || hours.data === null) return invalid(c);
    const estimate = await vaults.retentionEstimate(
      c.get("principal"),
      c.req.param("id"),
      hours.data,
    );
    if (!estimate) return notFound(c);
    return c.json({
      documents: estimate.documents,
      earliest_deletion_at: estimate.earliestDeletionAt,
    });
  });

  return app;
}

const transferBody = z.object({ new_owner_id: z.uuid() });
const purgeBody = z.object({ confirmation: z.literal("DELETE VAULT") });

export function adminVaultRoutes(vaults: Vaults, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const forbidden = (c: Context) =>
    c.json({ code: "FORBIDDEN", message: "Only an admin can do that." }, 403);

  app.get("/", async (c) => {
    const found = await vaults.adminList(c.get("principal"));
    if (!found) return forbidden(c);
    return c.json({
      vaults: found.map((v) => ({
        ...vaultJson(v),
        owner_email: v.ownerEmail,
        files: v.files,
        bytes: v.bytes,
        grants: v.grants,
      })),
    });
  });

  app.post("/:id/transfer", bodyLimit({ maxSize: 4096 }), async (c) => {
    const input = await body(c, transferBody);
    if (!input) return invalid(c);
    const done = await vaults.transfer(
      c.get("principal"),
      c.req.param("id"),
      input.new_owner_id,
      clientOf(c),
    );
    if (done === null) return forbidden(c);
    if (!done) return notFound(c);
    return c.json({ ok: true });
  });

  // Owners restore their own deleted vaults here too.
  app.post("/:id/restore", async (c) => {
    if (!(await vaults.restoreVault(c.get("principal"), c.req.param("id"), clientOf(c)))) {
      return notFound(c);
    }
    return c.json({ ok: true });
  });

  app.post("/:id/purge", bodyLimit({ maxSize: 4096 }), async (c) => {
    const input = await body(c, purgeBody);
    if (!input) return invalid(c);
    const done = await vaults.purge(c.get("principal"), c.req.param("id"), clientOf(c));
    if (done === null) return forbidden(c);
    if (!done) return notFound(c);
    return c.json({ ok: true });
  });

  return app;
}
