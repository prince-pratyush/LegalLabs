import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { SyncRefusal, SyncService } from "./service.js";

type Env = { Variables: { principal: Principal } };

const STATUS: Record<
  SyncRefusal,
  { status: 400 | 403 | 404 | 409 | 429 | 502 | 503; message: string }
> = {
  SYNC_UNAVAILABLE: { status: 503, message: "Connecting accounts isn't set up on this server." },
  PROVIDER_NOT_CONFIGURED: { status: 503, message: "That provider isn't set up on this server." },
  BAD_STATE: { status: 400, message: "The sign-in expired. Start again." },
  NOT_FOUND: { status: 404, message: "That wasn't found." },
  CONNECTION_NEEDS_REAUTH: { status: 409, message: "Connect this account again." },
  SYNC_TOO_SOON: { status: 429, message: "This vault was synced a moment ago. Try again soon." },
  IMPORT_TARGET_SYNCED: { status: 409, message: "A synced vault is read-only." },
  PROVIDER_ERROR: { status: 502, message: "The provider didn't answer as expected." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
  MATTER_REQUIRED_FOR_VAULT: { status: 400, message: "A vault needs a matter." },
  MATTER_NOT_ALLOWED_FOR_VAULT: { status: 400, message: "Vaults can't have a matter here." },
  FORBIDDEN: { status: 403, message: "Only the vault's owner can do that." },
};

const Provider = z.enum(["google_drive", "sharepoint"]);
const Cadence = z.union([z.literal(15), z.literal(60), z.literal(1440)]);
const Uri = z.string().url().max(500);
const Id = z.string().min(1).max(512);

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the request and try again." }, 400);
const refused = (c: Context, reason: SyncRefusal) =>
  c.json({ code: reason, message: STATUS[reason].message }, STATUS[reason].status);

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** Connections, the picker, search, import and synced vaults. Under /api/v1. */
export function syncRoutes(sync: SyncService, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();

  app.get("/sync/providers", (c) => c.json({ providers: sync.providersAvailable() }));

  app.get("/sync/connections", async (c) =>
    c.json({ items: await sync.connections(c.get("principal")) }),
  );

  app.post("/sync/connections/:provider/authorize", async (c) => {
    const provider = Provider.safeParse(c.req.param("provider"));
    const input = await body(c, z.object({ redirect_uri: Uri }));
    if (!provider.success || !input) return invalid(c);
    const r = await sync.authorize(c.get("principal"), provider.data, input.redirect_uri);
    return r.ok ? c.json(r.value) : refused(c, r.reason);
  });

  app.post("/sync/connections", async (c) => {
    const input = await body(
      c,
      z.object({
        code: z.string().min(1).max(2000),
        state: z.string().min(1).max(2000),
        redirect_uri: Uri,
      }),
    );
    if (!input) return invalid(c);
    const r = await sync.connect(c.get("principal"), {
      code: input.code,
      state: input.state,
      redirectUri: input.redirect_uri,
    });
    return r.ok ? c.json(r.value, 201) : refused(c, r.reason);
  });

  app.delete("/sync/connections/:id", async (c) => {
    const ok = await sync.unlink(c.get("principal"), c.req.param("id"));
    return ok ? c.body(null, 204) : refused(c, "NOT_FOUND");
  });

  // The picker: one level at a time. `drive_id` is omitted for the person's own drive.
  app.get("/sync/connections/:id/browse", async (c) => {
    const r = await sync.browse(c.get("principal"), c.req.param("id"), {
      driveId: c.req.query("drive_id") ?? null,
      folderId: c.req.query("folder_id") ?? null,
    });
    return r.ok ? c.json({ items: r.value }) : refused(c, r.reason);
  });

  app.get("/sync/connections/:id/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q === "" || q.length > 200) return invalid(c);
    const r = await sync.search(
      c.get("principal"),
      c.req.param("id"),
      c.req.query("drive_id") ?? null,
      q,
    );
    return r.ok ? c.json({ items: r.value }) : refused(c, r.reason);
  });

  app.post("/sync/connections/:id/import", async (c) => {
    const input = await body(
      c,
      z.object({
        vault_id: z.string().uuid(),
        folder_id: z.string().uuid().nullable().default(null),
        drive_id: Id.nullable().default(null),
        item_ids: z.array(Id).min(1).max(200),
      }),
    );
    if (!input) return invalid(c);
    const r = await sync.importItems(
      c.get("principal"),
      {
        connectionId: c.req.param("id"),
        driveId: input.drive_id,
        itemIds: input.item_ids,
        vaultId: input.vault_id,
        folderId: input.folder_id,
      },
      clientOf(c),
    );
    return r.ok ? c.json(r.value) : refused(c, r.reason);
  });

  app.post("/sync/vaults", async (c) => {
    const input = await body(
      c,
      z.object({
        connection_id: z.string().uuid(),
        drive_id: Id.nullable().default(null),
        folder_id: Id,
        name: z.string().trim().min(1).max(200),
        cadence_minutes: Cadence.default(60),
        matter_id: z.string().uuid().nullable().default(null),
      }),
    );
    if (!input) return invalid(c);
    const r = await sync.createSyncedVault(
      c.get("principal"),
      {
        connectionId: input.connection_id,
        driveId: input.drive_id,
        folderId: input.folder_id,
        name: input.name,
        cadenceMinutes: input.cadence_minutes,
        matterId: input.matter_id,
      },
      clientOf(c),
    );
    return r.ok
      ? c.json({ vault_id: r.value.vault.id, sync: r.value.sync }, 201)
      : refused(c, r.reason);
  });

  app.get("/vaults/:id/sync", async (c) => {
    const s = await sync.status(c.get("principal"), c.req.param("id"));
    return s ? c.json(s) : refused(c, "NOT_FOUND");
  });

  app.patch("/vaults/:id/sync", async (c) => {
    const input = await body(c, z.object({ cadence_minutes: Cadence }));
    if (!input) return invalid(c);
    const ok = await sync.setCadence(c.get("principal"), c.req.param("id"), input.cadence_minutes);
    return ok
      ? c.json(await sync.status(c.get("principal"), c.req.param("id")))
      : refused(c, "NOT_FOUND");
  });

  app.post("/vaults/:id/sync/run", async (c) => {
    const r = await sync.syncNow(c.get("principal"), c.req.param("id"));
    return r.ok ? c.json(r.value, 202) : refused(c, r.reason);
  });

  return app;
}
