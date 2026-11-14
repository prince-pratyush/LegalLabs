import { randomUUID } from "node:crypto";
import { contentKey, createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createRetentionJob } from "./retention.js";
import { createVaults } from "./vaults.js";

const pool = testPool();
afterAll(() => pool.end());

const OPEN = "The supplier accepts liability for direct loss.";
const SECRET = "The supplier accepts liability for indirect loss on matter 1042.";

type UploadBody = { file: { id: string; state: string }; code?: string };

function harness() {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const vaults = createVaults(pool, { documents, store });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    vaults,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const call = async (cookie: string, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const upload = async (
    cookie: string,
    vaultId: string,
    name: string,
    content: string,
    extra: Record<string, string> = {},
  ) => {
    const form = new FormData();
    form.set("file", new File([content], name));
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    const res = await app.request(`/api/v1/vaults/${vaultId}/files`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as UploadBody };
  };
  const drain = (m: Seeded) => documents.worker.drain(m.workspaceId);
  return { app, store, signIn, call, upload, drain, documents };
}

// A second person in the same workspace, with only the user permissions.
async function colleague(m: Seeded) {
  const email = `ben-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, '{threads.use}') returning id",
    [m.workspaceId, `User ${email}`],
  );
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role.rows[0]?.id],
  );
  const userId = user.rows[0]?.id ?? "";
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

// An open matter with a wall that keeps one person out.
async function walledMatter(m: Seeded, deniedUser: string) {
  const matter = await pool.query<{ id: string }>(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
     values ($1, 'C1', 'Client', $2, 'Matter 1042', 'open') returning id`,
    [m.workspaceId, `M-${randomUUID().slice(0, 6)}`],
  );
  const id = matter.rows[0]?.id ?? "";
  await pool.query(
    `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
     values ($1, $2, 'user', $3, 'deny')`,
    [m.workspaceId, id, deniedUser],
  );
  return id;
}

async function newVault(h: ReturnType<typeof harness>, cookie: string, name = "Deal room") {
  const res = await h.call(cookie, "POST", "/vaults", { name });
  expect(res.status).toBe(201);
  return res.body.vault.id as string;
}

const search = (h: ReturnType<typeof harness>, cookie: string, query: string) =>
  h.call(cookie, "GET", `/documents/search?q=${encodeURIComponent("supplier liability")}&${query}`);

describe("vaults API", () => {
  it("needs a session for every route", async () => {
    const h = harness();
    const id = randomUUID();
    for (const [method, path] of [
      ["GET", "/vaults"],
      ["POST", "/vaults"],
      ["GET", `/vaults/${id}/tree`],
      ["GET", "/admin/vaults"],
    ] as const) {
      expect((await h.call("", method, path)).status).toBe(401);
    }
  });

  it("creates a vault, files an upload into its folder path and reports it ready", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    const up = await h.upload(cookie, vault, "msa.txt", OPEN, { relative_path: "Contracts/2024" });
    expect(up.status).toBe(202);
    // The test harness reads each upload at once; live, it starts "queued".
    expect(up.body.file.state).toBe("ready");
    await h.drain(m);

    const top = await h.call(cookie, "GET", `/vaults/${vault}/tree`);
    expect(top.body.folders.map((f: { name: string }) => f.name)).toEqual(["Contracts"]);
    expect(top.body.files).toEqual([]);
    const contracts = top.body.folders[0].id;
    const inner = await h.call(cookie, "GET", `/vaults/${vault}/tree?folder_id=${contracts}`);
    const year = inner.body.folders[0].id;
    const leaf = await h.call(cookie, "GET", `/vaults/${vault}/tree?folder_id=${year}`);
    expect(leaf.body.path.map((f: { name: string }) => f.name)).toEqual(["Contracts", "2024"]);
    expect(leaf.body.files).toMatchObject([{ name: "msa.txt", state: "ready" }]);

    const detail = await h.call(cookie, "GET", `/vaults/${vault}`);
    expect(detail.body.vault.my_access).toBe("owner");
    expect(detail.body.stats).toMatchObject({ files: 1, ready: 1, failed: 0, hidden: 0 });

    // The same upload again gets a free name rather than a clash.
    await h.upload(cookie, vault, "msa.txt", OPEN, { folder_id: year });
    const again = await h.call(cookie, "GET", `/vaults/${vault}/tree?folder_id=${year}`);
    expect(again.body.files.map((f: { name: string }) => f.name)).toEqual([
      "msa (2).txt",
      "msa.txt",
    ]);
    expect((await h.call(cookie, "GET", "/documents")).body.documents).toEqual([]);
  });

  it("scopes search to a vault or a folder and everything under it", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    const other = await newVault(h, cookie, "Other");
    await h.upload(cookie, vault, "msa.txt", OPEN, { relative_path: "Contracts/2024" });
    await h.upload(cookie, other, "elsewhere.txt", SECRET);
    await h.drain(m);
    const contracts = (await h.call(cookie, "GET", `/vaults/${vault}/tree`)).body.folders[0].id;

    const names = async (query: string) =>
      (await search(h, cookie, query)).body.passages.map(
        (p: { document_name: string }) => p.document_name,
      );
    expect(await names(`vault_id=${vault}`)).toEqual(["msa.txt"]);
    expect(await names(`folder_id=${contracts}`)).toEqual(["msa.txt"]);
    expect(await names(`vault_id=${other}`)).toEqual(["elsewhere.txt"]);
    expect(await names(`vault_id=${vault}&folder_id=${randomUUID()}`)).toEqual([]);
    expect((await search(h, cookie, "vault_id=not-an-id")).status).toBe(400);
  });

  it("pages a folder by name without skipping or repeating", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    for (const name of ["e.txt", "a.txt", "c.txt", "b.txt", "d.txt"]) {
      await h.upload(cookie, vault, name, OPEN);
    }
    const seen: string[] = [];
    let cursor = "";
    do {
      const page = await h.call(
        cookie,
        "GET",
        `/vaults/${vault}/tree?limit=2${cursor && `&cursor=${cursor}`}`,
      );
      seen.push(...page.body.files.map((f: { name: string }) => f.name));
      cursor = page.body.next_cursor ?? "";
    } while (cursor);
    expect(seen).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
    const found = await h.call(cookie, "GET", `/vaults/${vault}/tree?q=C.TX`);
    expect(found.body.files.map((f: { name: string }) => f.name)).toEqual(["c.txt"]);
  });
});

describe("sharing and walls", () => {
  it("lets a viewer read and search but not change the vault", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ben = await colleague(m);
    const ana = await h.signIn(m);
    const benCookie = await h.signIn(ben);
    const vault = await newVault(h, ana);
    await h.upload(ana, vault, "msa.txt", OPEN);
    await h.drain(m);

    expect((await h.call(benCookie, "GET", `/vaults/${vault}`)).status).toBe(404);
    expect((await search(h, benCookie, `vault_id=${vault}`)).body.passages).toEqual([]);

    const found = await h.call(ana, "GET", `/vaults/principals?q=${ben.email.slice(0, 6)}`);
    expect(found.body.principals).toEqual([
      { principal_type: "user", principal_id: ben.userId, label: ben.email },
    ]);
    const shared = await h.call(ana, "PUT", `/vaults/${vault}/shares`, {
      grants: [{ principal_type: "user", principal_id: ben.userId, level: "view" }],
      workspace_view: false,
    });
    expect(shared.body).toMatchObject({
      denied_by_wall: [],
      grants: [{ principal_id: ben.userId, level: "view" }],
    });

    expect((await h.call(benCookie, "GET", `/vaults/${vault}`)).body.vault.my_access).toBe("view");
    expect((await search(h, benCookie, `vault_id=${vault}`)).body.passages).toHaveLength(1);
    expect((await h.upload(benCookie, vault, "mine.txt", OPEN)).status).toBe(403);
    expect(
      (await h.call(benCookie, "POST", `/vaults/${vault}/folders`, { name: "X" })).status,
    ).toBe(403);
    expect((await h.call(benCookie, "GET", `/vaults/${vault}/shares`)).status).toBe(404);
    expect((await h.call(benCookie, "DELETE", `/vaults/${vault}`)).status).toBe(404);
    expect(
      (await h.call(benCookie, "PATCH", `/vaults/${vault}`, { retention_hours: 24 })).status,
    ).toBe(403);
  });

  it("keeps a walled file out of a shared vault's search, tree and totals", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ben = await colleague(m);
    const ana = await h.signIn(m);
    const benCookie = await h.signIn(ben);
    const vault = await newVault(h, ana);
    await h.upload(ana, vault, "open.txt", OPEN);
    const secret = await h.upload(ana, vault, "secret.txt", SECRET);
    await h.drain(m);
    // A file can carry its own matter, as a synced DMS file does.
    const matter = await walledMatter(m, ben.userId);
    await pool.query("update content.document set matter_id = $1 where id = $2", [
      matter,
      secret.body.file.id,
    ]);
    await h.call(ana, "PUT", `/vaults/${vault}/shares`, {
      grants: [{ principal_type: "user", principal_id: ben.userId, level: "view" }],
      workspace_view: false,
    });

    const names = async (cookie: string, query: string) =>
      (await search(h, cookie, query)).body.passages
        .map((p: { document_name: string }) => p.document_name)
        .sort();
    expect(await names(ana, `vault_id=${vault}`)).toEqual(["open.txt", "secret.txt"]);
    expect(await names(benCookie, `vault_id=${vault}`)).toEqual(["open.txt"]);
    expect(await names(benCookie, "")).toEqual(["open.txt"]);
    expect(await names(benCookie, `document_id=${secret.body.file.id}`)).toEqual([]);

    const tree = await h.call(benCookie, "GET", `/vaults/${vault}/tree`);
    expect(tree.body.files.map((f: { name: string }) => f.name)).toEqual(["open.txt"]);
    expect(JSON.stringify(tree.body)).not.toContain("secret");
    const stats = (await h.call(benCookie, "GET", `/vaults/${vault}`)).body.stats;
    expect(stats).toMatchObject({ files: 2, hidden: 1 });
  });

  it("refuses to share a matter vault with someone walled off from the matter", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ben = await colleague(m);
    const ana = await h.signIn(m);
    const matter = await walledMatter(m, ben.userId);
    const res = await h.call(ana, "POST", "/vaults", { name: "Matter 1042", matter_id: matter });
    const vault = res.body.vault.id;
    const shared = await h.call(ana, "PUT", `/vaults/${vault}/shares`, {
      grants: [{ principal_type: "user", principal_id: ben.userId, level: "edit" }],
      workspace_view: true,
    });
    expect(shared.body.denied_by_wall).toEqual([ben.userId]);
    expect(shared.body.grants).toEqual([]);
    expect(shared.body.workspace_view).toBe(true);
    // Even shared with the whole workspace, the wall keeps the vault from him.
    expect((await h.call(await h.signIn(ben), "GET", `/vaults/${vault}`)).status).toBe(404);
    const actions = (await auditTrail(pool, m.workspaceId)).map((row) => row.action);
    expect(actions).toContain("wall.share_blocked");
  });
});

describe("the recycle bin, limits and admin", () => {
  it("hides deleted files from the tree and search until they are restored", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    const file = await h.upload(cookie, vault, "msa.txt", OPEN);
    await h.drain(m);
    const id = file.body.file.id;
    expect(
      (await h.call(cookie, "POST", `/vaults/${vault}/trash`, { document_ids: [id] })).body,
    ).toEqual({
      items: 1,
    });
    expect((await h.call(cookie, "GET", `/vaults/${vault}/tree`)).body.files).toEqual([]);
    expect((await search(h, cookie, `vault_id=${vault}`)).body.passages).toEqual([]);
    const bin = await h.call(cookie, "GET", `/vaults/${vault}/bin`);
    expect(bin.body.items).toMatchObject([
      { kind: "document", id, name: "msa.txt", deleted_reason: "user" },
    ]);
    await h.call(cookie, "POST", `/vaults/${vault}/restore`, { document_ids: [id] });
    expect((await search(h, cookie, `vault_id=${vault}`)).body.passages).toHaveLength(1);
  });

  it("checks a manifest against type and vault limits before any bytes are sent", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    await h.upload(cookie, vault, "one.txt", OPEN);
    await pool.query(
      `update core.workspace set settings = '{"vault_limits": {"files": 2}}' where id = $1`,
      [m.workspaceId],
    );
    const res = await h.call(cookie, "POST", `/vaults/${vault}/uploads`, {
      files: [
        { client_ref: "a", name: "big.xlsx", size: 21 * 1024 ** 2 },
        { client_ref: "b", name: "photo.heic", size: 10 },
        { client_ref: "c", name: "ok.pdf", size: 10 },
        { client_ref: "d", name: "late.pdf", size: 10 },
      ],
    });
    expect(res.body).toEqual({
      accepted: [{ client_ref: "c" }],
      rejected: [
        { client_ref: "a", reason: "FILE_TOO_LARGE" },
        { client_ref: "b", reason: "UNSUPPORTED_TYPE" },
        { client_ref: "d", reason: "VAULT_FILE_LIMIT" },
      ],
    });
    await h.upload(cookie, vault, "two.txt", OPEN);
    const third = await h.upload(cookie, vault, "three.txt", OPEN);
    expect(third).toMatchObject({ status: 409, body: { code: "VAULT_FILE_LIMIT" } });
  });

  it("lets an admin list, transfer and purge vaults, and owners restore theirs", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ben = await colleague(m);
    const ana = await h.signIn(m);
    const benCookie = await h.signIn(ben);
    const vault = await newVault(h, ana);
    const file = await h.upload(ana, vault, "msa.txt", OPEN);
    await h.drain(m);

    expect((await h.call(benCookie, "GET", "/admin/vaults")).status).toBe(403);
    const list = await h.call(ana, "GET", "/admin/vaults");
    expect(list.body.vaults).toMatchObject([{ id: vault, files: 1, owner_email: m.email }]);

    await h.call(ana, "POST", `/admin/vaults/${vault}/transfer`, { new_owner_id: ben.userId });
    expect((await h.call(benCookie, "GET", `/vaults/${vault}`)).body.vault.my_access).toBe("owner");
    expect((await h.call(ana, "GET", `/vaults/${vault}`)).body.vault.my_access).toBe("full");

    expect((await h.call(benCookie, "DELETE", `/vaults/${vault}`)).status).toBe(202);
    expect((await h.call(benCookie, "GET", "/vaults")).body.vaults).toEqual([]);
    expect((await h.call(benCookie, "POST", `/admin/vaults/${vault}/restore`)).status).toBe(200);
    expect((await h.call(benCookie, "GET", "/vaults")).body.vaults).toHaveLength(1);

    await h.call(benCookie, "DELETE", `/vaults/${vault}`);
    expect(
      (await h.call(ana, "POST", `/admin/vaults/${vault}/purge`, { confirmation: "yes" })).status,
    ).toBe(400);
    const key = contentKey(
      m.workspaceId,
      (
        await pool.query<{ sha256: Buffer }>(
          "select sha256 from content.document_version where document_id = $1",
          [file.body.file.id],
        )
      ).rows[0]?.sha256.toString("hex") ?? "",
    );
    expect(await h.store.get(key)).not.toBeNull();
    expect(
      (await h.call(ana, "POST", `/admin/vaults/${vault}/purge`, { confirmation: "DELETE VAULT" }))
        .status,
    ).toBe(200);
    expect(await h.store.get(key)).toBeNull();
    expect((await h.call(ana, "GET", "/admin/vaults")).body.vaults).toEqual([]);
  });

  it("applies a vault's retention and deletes those files for good", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    const file = await h.upload(cookie, vault, "old.txt", OPEN);
    const kept = await h.upload(cookie, vault, "kept.txt", `${OPEN} Kept.`);
    await h.drain(m);
    await pool.query(
      "update content.document set created_at = now() - interval '2 days' where id = $1",
      [file.body.file.id],
    );
    const estimate = await h.call(cookie, "GET", `/vaults/${vault}/retention/estimate?hours=24`);
    expect(estimate.body.documents).toBe(1);
    expect((await h.call(cookie, "PATCH", `/vaults/${vault}`, { retention_hours: 2 })).status).toBe(
      400,
    );
    expect(
      (await h.call(cookie, "PATCH", `/vaults/${vault}`, { retention_hours: 24 })).status,
    ).toBe(200);

    // A file someone deleted waits in the bin; retention doesn't.
    await h.call(cookie, "POST", `/vaults/${vault}/trash`, { document_ids: [kept.body.file.id] });
    const job = createRetentionJob(pool, { store: h.store });
    expect((await job.runOnce()).moved).toBeGreaterThanOrEqual(1);
    const bin = await h.call(cookie, "GET", `/vaults/${vault}/bin`);
    expect(bin.body.items.map((i: { id: string }) => i.id)).toEqual([kept.body.file.id]);
    const gone = await pool.query("select 1 from content.document where id = $1", [
      file.body.file.id,
    ]);
    expect(gone.rows).toEqual([]);

    await pool.query(
      "update content.document set deleted_at = now() - interval '31 days' where id = $1",
      [kept.body.file.id],
    );
    await job.runOnce();
    expect((await h.call(cookie, "GET", `/vaults/${vault}/bin`)).body.items).toEqual([]);
    const actions = (await auditTrail(pool, m.workspaceId)).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "retention.policy_changed",
        "retention.sweep",
        "document.deleted",
        "deletion.completed",
      ]),
    );
  });

  it("refuses to move a folder inside itself", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const vault = await newVault(h, cookie);
    const outer = (await h.call(cookie, "POST", `/vaults/${vault}/folders`, { name: "Outer" })).body
      .folder.id;
    const inner = (
      await h.call(cookie, "POST", `/vaults/${vault}/folders`, { name: "Inner", parent_id: outer })
    ).body.folder.id;
    const res = await h.call(cookie, "PATCH", `/vaults/${vault}/folders/${outer}`, {
      parent_id: inner,
    });
    expect(res.status).toBe(409);
    const twin = await h.call(cookie, "POST", `/vaults/${vault}/folders`, { name: "outer" });
    expect(twin.body.folder.name).toBe("outer (2)");
  });
});
