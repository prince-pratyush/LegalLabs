import { randomBytes } from "node:crypto";
import { createMemoryStore } from "@legallabs/storage";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createSecretBox } from "../admin-models/secrets.js";
import type { Principal } from "../auth/auth.js";
import { createDocuments } from "../documents/documents.js";
import type { NotificationEvent } from "../notifications/notify.js";
import { type Seeded, seedMember, testPool } from "../test-db.js";
import { createVaults } from "../vaults/vaults.js";
import { createSyncEngine } from "./engine.js";
import { createGoogleDrive } from "./google-drive.js";
import { MockDrive, MockGraph, type MockServer } from "./mock-drives.js";
import { createSyncService } from "./service.js";
import { createSharePoint } from "./sharepoint.js";
import type { SyncProvider, SyncProviderId } from "./types.js";

// Everything here runs against mock Drive and Graph servers: no live account was available,
// so the real vendors' behaviour is UNVERIFIED.
const pool = testPool();
// Only this pool's sessions may write into a synced (read-only) vault.
const writer = new pg.Pool({
  connectionString: inject("databaseUrl"),
  options: "-c legallabs.sync_writer=on",
  max: 3,
});
afterAll(async () => {
  await pool.end();
  await writer.end();
});

const secrets = createSecretBox(randomBytes(32).toString("base64"));
const client = { ip: null, userAgent: "test" };
const noSleep = async () => {};

interface Rig {
  m: Seeded;
  p: Principal;
  kind: SyncProviderId;
  server: MockServer;
  service: ReturnType<typeof createSyncService>;
  engine: ReturnType<typeof createSyncEngine>;
  events: NotificationEvent[];
  vaultId: string;
  connectionId: string;
  run: () => ReturnType<ReturnType<typeof createSyncEngine>["run"]>;
}

async function rig(
  kind: SyncProviderId,
  mock: MockDrive | MockGraph,
  rootId: string,
): Promise<Rig> {
  const server = await mock.start();
  const common = {
    fetch: (u: string, i?: RequestInit) => fetch(u, i),
    sleep: noSleep,
    clientId: "cid",
    clientSecret: "cs",
  };
  const provider: SyncProvider =
    kind === "google_drive"
      ? createGoogleDrive({ ...common, apiBase: server.url, tokenUrl: `${server.url}/token` })
      : createSharePoint({ ...common, graphBase: server.url, authBase: server.url });
  const providers = { [kind]: provider };
  const m = await seedMember(pool);
  const p: Principal = { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
  const store = createMemoryStore();
  const vaults = createVaults(pool, { documents: createDocuments(pool, { store }), store });
  const service = createSyncService(pool, { secrets, providers, vaults });
  const events: NotificationEvent[] = [];
  const engine = createSyncEngine({
    pool: writer,
    documents: createDocuments(writer, { store }),
    secrets,
    providers,
    notifier: { notify: async (_p, e) => void events.push(e) },
  });
  // OAuth round trip against the mock token endpoint.
  const auth = await service.authorize(p, kind, "https://app.test/cb");
  if (!auth.ok) throw new Error(auth.reason);
  const state = new URL(auth.value.url).searchParams.get("state") as string;
  const conn = await service.connect(p, {
    code: "code",
    state,
    redirectUri: "https://app.test/cb",
  });
  if (!conn.ok) throw new Error(conn.reason);
  const made = await service.createSyncedVault(
    p,
    {
      connectionId: conn.value.id,
      driveId: kind === "sharepoint" ? "d1" : null,
      folderId: rootId,
      name: "Synced",
    },
    client,
  );
  if (!made.ok) throw new Error(made.reason);
  const vaultId = made.value.vault.id;
  return {
    m,
    p,
    kind,
    server,
    service,
    engine,
    events,
    vaultId,
    connectionId: conn.value.id,
    run: () => engine.run(vaultId, m.workspaceId, m.userId),
  };
}

const docs = async (vaultId: string) =>
  (
    await pool.query<{
      id: string;
      name: string;
      deleted_at: Date | null;
      folder: string | null;
      versions: string;
    }>(
      `select d.id, d.name, d.deleted_at, f.name folder,
              (select count(*) from content.document_version v where v.document_id = d.id) versions
         from content.document d left join content.folder f on f.id = d.folder_id
        where d.vault_id = $1 order by d.name`,
      [vaultId],
    )
  ).rows;
const live = async (vaultId: string) => (await docs(vaultId)).filter((d) => !d.deleted_at);
const names = async (vaultId: string) => (await live(vaultId)).map((d) => d.name).sort();

describe("Google Drive sync (mock server, live account UNVERIFIED)", () => {
  let drive: MockDrive;
  let r: Rig;
  let sub: string;
  let a: string;
  let b: string;
  let c: string;
  beforeEach(async () => {
    drive = new MockDrive();
    drive.folder("Matter", "root", "top");
    sub = drive.folder("Contracts", "top");
    a = drive.put("alpha.txt", "top", "alpha v1 text");
    b = drive.put("beta.txt", sub, "beta v1 text");
    c = drive.put("gamma.md", sub, "gamma v1 text");
    drive.put("Memo", "top", "memo body", "application/vnd.google-apps.document");
    drive.put("holiday.heic", "top", "pixels", "image/heic");
    drive.put("form", "top", "x", "application/vnd.google-apps.form");
    r = await rig("google_drive", drive, "top");
  });

  it("imports the folder on the first run, exports Google Docs as .docx, lists what it skipped", async () => {
    const out = await r.run();
    expect(out).toMatchObject({ status: "ok", full: true });
    expect(await names(r.vaultId)).toEqual(["Memo.docx", "alpha.txt", "beta.txt", "gamma.md"]);
    const beta = (await live(r.vaultId)).find((d) => d.name === "beta.txt");
    expect(beta?.folder).toBe("Contracts");
    const status = await r.service.status(r.p, r.vaultId);
    expect(status?.status).toBe("ok");
    expect(status?.lastCounts).toMatchObject({ created: 4, skipped: 2 });
    expect(status?.skipped.map((s) => s.name).sort()).toEqual(["form", "holiday.heic"]);
  });

  it("keeps a synced vault current: rename keeps the id, edits add a version, deletions go to the bin", async () => {
    await r.run();
    const before = new Map((await live(r.vaultId)).map((d) => [d.name, d]));
    drive.rename(a, "alpha-renamed.txt");
    drive.put("beta.txt", sub, "beta v2 text, longer", "text/plain", b);
    drive.trash(c);
    drive.put("delta.txt", "top", "brand new");
    const out = await r.run();
    expect(out).toMatchObject({ status: "ok", full: false });
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.counts).toMatchObject({ renamed: 1, updated: 1, deleted: 1, created: 1 });
    const after = await docs(r.vaultId);
    const renamed = after.find((d) => d.name === "alpha-renamed.txt");
    expect(renamed?.id).toBe(before.get("alpha.txt")?.id);
    const beta = after.find((d) => d.name === "beta.txt");
    expect(beta?.id).toBe(before.get("beta.txt")?.id);
    expect(Number(beta?.versions)).toBe(2);
    expect(after.find((d) => d.name === "gamma.md")?.deleted_at).not.toBeNull();
    expect(await names(r.vaultId)).toContain("delta.txt");
    // A run with nothing new changes nothing.
    const quiet = await r.run();
    expect(quiet.status === "ok" && quiet.counts).toMatchObject({
      created: 0,
      updated: 0,
      deleted: 0,
    });
  });

  it("follows moves: out of the tree is a deletion, a new folder brings its unlisted contents", async () => {
    await r.run();
    drive.folder("Outside", "root", "outside");
    drive.move(b, "outside");
    // A folder that already had files is moved into the synced tree.
    drive.folder("Archive", "root", "archive");
    drive.put("old.txt", "archive", "old text");
    await r.run();
    drive.move("archive", "top");
    const out = await r.run();
    expect(out.status).toBe("ok");
    const now = await live(r.vaultId);
    expect(now.map((d) => d.name)).not.toContain("beta.txt");
    expect(now.find((d) => d.name === "old.txt")?.folder).toBe("Archive");
  });

  it("deleting a folder bins everything under it", async () => {
    await r.run();
    drive.remove(sub);
    await r.run();
    expect(await names(r.vaultId)).toEqual(["Memo.docx", "alpha.txt"]);
  });

  it("refuses edits by people: the vault is read-only", async () => {
    await r.run();
    const docsApi = createDocuments(pool, { store: createMemoryStore() });
    await expect(
      docsApi.upload(
        r.p,
        { name: "mine.txt", bytes: Buffer.from("x"), matterId: null, vaultId: r.vaultId },
        client,
      ),
    ).rejects.toThrow("VAULT_READ_ONLY");
    const doc = (await live(r.vaultId))[0];
    await expect(
      pool
        .query("select set_config('app.user_id', $1, false)", [r.m.userId])
        .then(() => pool.query("update content.document set name = 'x' where id = $1", [doc?.id])),
    ).rejects.toThrow("VAULT_READ_ONLY");
  });

  it("renews an expired access token and stores the new one sealed", async () => {
    await r.run();
    r.server.validTokens.clear(); // every token we hold is now refused
    r.server.refreshTokens.add("refresh-2"); // from the code exchange
    drive.put("late.txt", "top", "late");
    const out = await r.run();
    expect(out.status).toBe("ok");
    expect(await names(r.vaultId)).toContain("late.txt");
    const { rows } = await pool.query<{ ciphertext: Buffer }>(
      "select s.ciphertext from admin.secret s join content.sync_connection c on c.secret_ref = s.id where c.id = $1",
      [r.connectionId],
    );
    const stored = JSON.parse(secrets.open(rows[0]?.ciphertext as Buffer));
    expect(stored.accessToken).not.toBe("access-2");
    expect(rows[0]?.ciphertext.toString("utf8")).not.toContain("refresh-");
  });

  it("when permission is revoked the vault goes to sync_error, the owner is told, files stay", async () => {
    await r.run();
    drive.revoked.add("top");
    drive.put("after.txt", "top", "x");
    const out = await r.run();
    expect(out).toMatchObject({ status: "sync_error", code: "ACCESS_REVOKED" });
    expect((await r.service.status(r.p, r.vaultId))?.status).toBe("sync_error");
    expect(await names(r.vaultId)).toEqual(["Memo.docx", "alpha.txt", "beta.txt", "gamma.md"]);
    expect(r.events.map((e) => e.kind)).toEqual(["vault.sync_failed"]);
    const conn = (await r.service.connections(r.p))[0];
    expect(conn?.status).toBe("needs_reauth");
  });

  it("lists the folder again when the change token has expired", async () => {
    await r.run();
    drive.remove(b);
    drive.put("fresh.txt", "top", "fresh");
    r.server.expireChangeToken = true;
    const out = await r.run();
    expect(out).toMatchObject({ status: "ok", full: true });
    const n = await names(r.vaultId);
    expect(n).toContain("fresh.txt");
    expect(n).not.toContain("beta.txt");
  });

  it("backs off on throttling and carries on", async () => {
    r.server.throttle = 2;
    const out = await r.run();
    expect(out.status).toBe("ok");
    expect(await names(r.vaultId)).toHaveLength(4);
  });

  it("runs one sync per vault at a time", async () => {
    const [x, y] = await Promise.all([r.run(), r.run()]);
    expect([x.status, y.status].sort()).toEqual(["busy", "ok"]);
  });

  it("limits manual syncs to one per five minutes", async () => {
    await r.run();
    const again = await r.service.syncNow(r.p, r.vaultId);
    expect(again).toEqual({ ok: false, reason: "SYNC_TOO_SOON" });
  });

  it("serves the picker and search, and imports into a normal vault", async () => {
    const top = await r.service.browse(r.p, r.connectionId, { driveId: null, folderId: "top" });
    expect(top.ok && top.value.map((i) => i.name)).toContain("Contracts");
    const found = await r.service.search(r.p, r.connectionId, null, "gamma");
    expect(found.ok && found.value[0]).toMatchObject({
      id: c,
      title: "gamma.md",
      url: expect.stringContaining(c),
    });
    const store = createMemoryStore();
    const vaults = createVaults(pool, { documents: createDocuments(pool, { store }), store });
    const plain = await vaults.create(r.p, { name: "Plain" }, client);
    if (!plain.ok) throw new Error("vault");
    const res = await r.service.importItems(
      r.p,
      {
        connectionId: r.connectionId,
        driveId: null,
        itemIds: [sub],
        vaultId: plain.value.id,
        folderId: null,
      },
      client,
    );
    expect(res).toEqual({ ok: true, value: { imported: 2, skipped: 0 } });
    expect((await live(plain.value.id)).map((d) => d.folder)).toEqual(["Contracts", "Contracts"]);
    const refusal = await r.service.importItems(
      r.p,
      {
        connectionId: r.connectionId,
        driveId: null,
        itemIds: [a],
        vaultId: r.vaultId,
        folderId: null,
      },
      client,
    );
    expect(refusal).toEqual({ ok: false, reason: "IMPORT_TARGET_SYNCED" });
  });

  it("will not unlink a connection a synced vault still uses", async () => {
    expect(await r.service.unlink(r.p, r.connectionId)).toBe(false);
  });
});

describe("SharePoint sync (mock Graph, live tenant UNVERIFIED)", () => {
  it("imports, then follows rename, edit, move out and delete through delta", async () => {
    const graph = new MockGraph();
    graph.folder("Matter", "root", "top");
    const sub = graph.folder("Contracts", "top");
    const a = graph.put("alpha.txt", "top", "alpha one");
    const b = graph.put("beta.txt", sub, "beta one");
    const c = graph.put("gamma.txt", sub, "gamma one");
    graph.put("elsewhere.txt", "root", "not ours");
    const r = await rig("sharepoint", graph, "top");

    expect(await r.run()).toMatchObject({ status: "ok", full: true });
    expect(await names(r.vaultId)).toEqual(["alpha.txt", "beta.txt", "gamma.txt"]);
    const ids = new Map((await live(r.vaultId)).map((d) => [d.name, d.id]));

    graph.rename(a, "alpha-final.txt");
    graph.put("beta.txt", sub, "beta two is longer", b);
    graph.remove(c);
    graph.put("outside-edit.txt", "root", "unrelated change");
    graph.put("delta.txt", "top", "new file");
    const out = await r.run();
    expect(out).toMatchObject({ status: "ok", full: false });
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.counts).toMatchObject({ renamed: 1, updated: 1, deleted: 1, created: 1 });
    const after = await docs(r.vaultId);
    expect(after.find((d) => d.name === "alpha-final.txt")?.id).toBe(ids.get("alpha.txt"));
    expect(Number(after.find((d) => d.name === "beta.txt")?.versions)).toBe(2);
    expect(after.find((d) => d.name === "gamma.txt")?.deleted_at).not.toBeNull();
    expect(after.map((d) => d.name)).not.toContain("outside-edit.txt");

    graph.move(b, "root"); // out of the synced folder
    await r.run();
    expect(await names(r.vaultId)).not.toContain("beta.txt");
  });

  it("goes to sync_error when the folder is no longer reachable", async () => {
    const graph = new MockGraph();
    graph.folder("Matter", "root", "top");
    graph.put("alpha.txt", "top", "alpha");
    const r = await rig("sharepoint", graph, "top");
    await r.run();
    graph.revoked.add("top");
    const out = await r.run();
    expect(out).toMatchObject({ status: "sync_error", code: "ACCESS_REVOKED" });
    expect(await names(r.vaultId)).toEqual(["alpha.txt"]);
  });

  it("revokes cleanly when the refresh token is refused", async () => {
    const graph = new MockGraph();
    graph.folder("Matter", "root", "top");
    graph.put("alpha.txt", "top", "alpha");
    const r = await rig("sharepoint", graph, "top");
    await r.run();
    r.server.validTokens.clear();
    r.server.refreshTokens.clear();
    const out = await r.run();
    expect(out).toMatchObject({ status: "sync_error", code: "AUTH_REVOKED" });
    expect((await r.service.connections(r.p))[0]?.status).toBe("needs_reauth");
    expect(await names(r.vaultId)).toEqual(["alpha.txt"]);
  });
});
