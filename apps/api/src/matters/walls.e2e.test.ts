import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { auditTrail } from "../test-db.js";
import { matterHarness, type Person } from "../test-matters.js";

// The worked examples and SPC-007 acceptance, driven only through the HTTP API.
// Room for the 1,000 retrieval queries to run ten at a time.
const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 12 });
afterAll(() => pool.end());
const h = matterHarness(pool);

const PLANTED = "Acme indemnity escrow holdback is fourteen percent";

let admin: Person;
let ana: Person;
let ben: Person;
let cal: Person;
let corpTeam: string;
let litTeam: string;
let m1: string;
let m2: string;
let m1Vault: string;

const matter = async (fields: Record<string, unknown>) => {
  const res = await h.call(admin, "POST", "/matters", fields);
  expect(res.status).toBe(201);
  return res.body.matter.id as string;
};
const wall = async (body: Record<string, unknown>) => {
  const res = await h.call(admin, "POST", "/admin/walls", body);
  expect(res.status).toBe(201);
  return res.body.wall.id as string;
};
const evaluate = async (who: Person, matterId: string | null) =>
  (
    await h.call(admin, "POST", "/admin/walls/evaluate", {
      user_id: who.userId,
      matter_id: matterId,
    })
  ).body;
const csv = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n");
const upload = async (who: Person, path: string, content: string) =>
  h.postFile(who, path, "walls.csv", content);

beforeAll(async () => {
  admin = await h.workspace();
  ana = await h.member(admin, "ana");
  ben = await h.member(admin, "ben");
  cal = await h.member(admin, "cal");
  corpTeam = await h.group(admin, "corp-team", [ana, ben]);
  litTeam = await h.group(admin, "lit-team", [cal]);
  m1 = await matter({
    client_id: "00123",
    client_name: "Acme",
    matter_number: "0001",
    matter_name: "Acme acquisition",
    wall_mode: "allow_list",
  });
  m2 = await matter({
    client_id: "00456",
    client_name: "Beta",
    matter_number: "0001",
    matter_name: "Beta dispute",
  });
  await wall({ matter_id: m1, principal_type: "group", principal_id: corpTeam, effect: "allow" });
  await wall({ matter_id: m1, principal_type: "user", principal_id: ben.userId, effect: "deny" });
  await wall({ matter_id: m2, principal_type: "user", principal_id: cal.userId, effect: "deny" });

  // Ana's M1 vault holds the planted passage, shared even with lit-team: the wall still wins.
  const vault = await h.call(ana, "POST", "/vaults", { name: "Acme deal", matter_id: m1 });
  expect(vault.status).toBe(201);
  m1Vault = vault.body.vault.id;
  const file = await h.postFile(ana, `/vaults/${m1Vault}/files`, "escrow.txt", `${PLANTED}.`);
  expect(file.status).toBe(202);
  await h.drain(admin);
  const shared = await h.call(ana, "PUT", `/vaults/${m1Vault}/shares`, {
    grants: [{ principal_type: "group", principal_id: litTeam, level: "view" }],
    workspace_view: false,
  });
  expect(shared.status).toBe(200);
});

describe("§4.13 worked examples through POST /admin/walls/evaluate", () => {
  it("gives each person's answer and reason", async () => {
    const cases: [Person, () => string, boolean, string][] = [
      [ana, () => m1, true, "allowed"],
      [ben, () => m1, false, "deny"],
      [cal, () => m1, false, "not_allow_listed"],
      [ana, () => m2, true, "open"],
      [cal, () => m2, false, "deny"],
    ];
    for (const [who, matterId, allowed, reason] of cases) {
      expect(await evaluate(who, matterId())).toMatchObject({ allowed, reason });
    }
    expect((await evaluate(cal, null)).reason).toBe("no_matter");
  });

  it("lists the matched rules, and audits every evaluation", async () => {
    const ben1 = await evaluate(ben, m1);
    expect(ben1.matched_rules.map((r: { effect: string }) => r.effect).sort()).toEqual([
      "allow",
      "deny",
    ]);
    const trail = await auditTrail(pool, admin.workspaceId);
    expect(trail.filter((e) => e.action === "wall.evaluated").length).toBeGreaterThan(0);
  });

  it("is for matters admins only", async () => {
    const res = await h.call(ana, "POST", "/admin/walls/evaluate", {
      user_id: cal.userId,
      matter_id: m1,
    });
    expect(res.status).toBe(403);
  });
});

describe("Cal is walled from M1", () => {
  it("doesn't see M1 in the picker or the matter list, and gets 404 on it", async () => {
    const picker = await h.call(cal, "GET", "/matters?scope=picker");
    expect(picker.body.items.map((m: { id: string }) => m.id)).not.toContain(m1);
    const all = await h.call(cal, "GET", "/matters");
    expect(all.body.items.map((m: { id: string }) => m.id)).toEqual([]);
    expect((await h.call(cal, "GET", `/matters/${m1}`)).status).toBe(404);
    // Ana sees M1 and M2 in hers.
    const anas = await h.call(ana, "GET", "/matters?scope=picker");
    expect(anas.body.items.map((m: { id: string }) => m.id).sort()).toEqual([m1, m2].sort());
  });

  it("doesn't see the M1 vault in his list, and fetching it is 404 not 403", async () => {
    const list = await h.call(cal, "GET", "/vaults");
    expect(list.body.vaults.map((v: { id: string }) => v.id)).not.toContain(m1Vault);
    const one = await h.call(cal, "GET", `/vaults/${m1Vault}`);
    expect(one.status).toBe(404);
    expect((await h.call(ana, "GET", `/vaults/${m1Vault}`)).status).toBe(200);
  });

  it("retrieves zero planted M1 passages across 1,000 queries, while Ana finds them", async () => {
    const words = PLANTED.toLowerCase().split(" ");
    const queries = Array.from({ length: 1000 }, (_, i) => {
      const a = words[i % words.length];
      const b = words[(i * 7 + 3) % words.length];
      return i % 3 === 0 ? `${a}` : `${a} ${b}`;
    });
    const anaHits = await h.call(
      ana,
      "GET",
      `/documents/search?q=${encodeURIComponent("escrow holdback")}`,
    );
    expect(anaHits.status).toBe(200);
    expect(anaHits.body.passages.length).toBeGreaterThan(0);
    let hits = 0;
    for (let i = 0; i < queries.length; i += 10) {
      const batch = await Promise.all(
        queries
          .slice(i, i + 10)
          .map((q) => h.call(cal, "GET", `/documents/search?q=${encodeURIComponent(q)}`)),
      );
      for (const res of batch) {
        expect(res.status).toBe(200);
        hits += res.body.passages.length;
      }
    }
    expect(hits).toBe(0);
  }, 120_000);
});

describe("require_walls_for_sharing", () => {
  let m2Thread: string;
  let m2Vault: string;

  beforeAll(async () => {
    const patched = await h.call(admin, "PATCH", `/matters/${m2}`, {
      require_walls_for_sharing: true,
    });
    expect(patched.status).toBe(200);
    const vault = await h.call(ana, "POST", "/vaults", { name: "Beta file", matter_id: m2 });
    m2Vault = vault.body.vault.id;
    const file = await h.postFile(ana, `/vaults/${m2Vault}/files`, "claim.txt", "Beta claim.");
    await h.drain(admin);
    const asked = await h.call(ana, "POST", "/threads", {
      content: "Summarise the claim",
      scope: { document_ids: [file.body.file.id], vault_ids: [], sources: [] },
      matter_id: m2,
    });
    expect(asked.status).toBe(202);
    m2Thread = asked.body.thread_id;
  });

  const grants = async (principal: string) =>
    (
      await pool.query<{ suspended_reason: string | null }>(
        "select suspended_reason from core.share_grant where object_id = $1 and principal_id = $2",
        [m2Thread, principal],
      )
    ).rows;

  it("refuses a thread share to lit-team with a count only", async () => {
    const res = await h.call(ana, "POST", `/threads/${m2Thread}/shares`, { group_ids: [litTeam] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "WALL_SHARE_BLOCKED", blocked_count: 1 });
    expect(JSON.stringify(res.body)).not.toContain(cal.userId);
    expect(JSON.stringify(res.body)).not.toContain(cal.email);
    const trail = await auditTrail(pool, admin.workspaceId);
    const blocked = trail.find(
      (e) => e.action === "wall.share_blocked" && e.object_type === "thread",
    );
    expect(blocked?.details).toMatchObject({
      object_type: "thread",
      blocked_count: 1,
    });
    expect(await grants(litTeam)).toEqual([]);
  });

  it("refuses a vault share that would reach a walled person", async () => {
    const res = await h.call(ana, "PUT", `/vaults/${m2Vault}/shares`, {
      grants: [{ principal_type: "user", principal_id: cal.userId, level: "view" }],
      workspace_view: false,
    });
    expect(res.status).toBe(403);
    expect(res.body.blocked_count).toBe(1);
    const everyone = await h.call(ana, "PUT", `/vaults/${m2Vault}/shares`, {
      grants: [],
      workspace_view: true,
    });
    expect(everyone.status).toBe(403);
  });

  it("creates nothing to reinstate when Cal's deny row is later removed", async () => {
    const walls = await h.call(admin, "GET", `/admin/walls?filter[matter_id]=${m2}`);
    const calRow = walls.body.items.find(
      (w: { principal_id: string }) => w.principal_id === cal.userId,
    );
    expect((await h.call(admin, "DELETE", `/admin/walls/${calRow.id}`)).status).toBe(204);
    expect(await grants(litTeam)).toEqual([]);
    await wall({ matter_id: m2, principal_type: "user", principal_id: cal.userId, effect: "deny" });
  });

  it("suspends a compliant group grant when a member is walled, and reinstates it", async () => {
    const shared = await h.call(ana, "POST", `/threads/${m2Thread}/shares`, {
      group_ids: [corpTeam],
    });
    expect(shared.status).toBe(200);
    expect(shared.body.created).toEqual([corpTeam]);
    expect((await h.call(ben, "GET", `/threads/${m2Thread}`)).status).toBe(200);

    const benDeny = await wall({
      matter_id: m2,
      principal_type: "user",
      principal_id: ben.userId,
      effect: "deny",
    });
    expect(await grants(corpTeam)).toEqual([{ suspended_reason: "wall" }]);
    expect((await h.call(ben, "GET", `/threads/${m2Thread}`)).status).toBe(404);

    expect((await h.call(admin, "DELETE", `/admin/walls/${benDeny}`)).status).toBe(204);
    expect(await grants(corpTeam)).toEqual([{ suspended_reason: null }]);
    expect((await h.call(ben, "GET", `/threads/${m2Thread}`)).status).toBe(200);

    const actions = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(actions).toContain("wall.share_suspended");
    expect(actions).toContain("wall.share_reinstated");
    expect(actions).toContain("wall.require_sharing_toggled");
  });

  it("suspends the grant when a walled person joins the group", async () => {
    await pool.query(
      "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
      [admin.workspaceId, corpTeam, cal.userId],
    );
    expect(await grants(corpTeam)).toEqual([{ suspended_reason: "wall" }]);
    await pool.query("delete from core.group_member where group_id = $1 and user_id = $2", [
      corpTeam,
      cal.userId,
    ]);
    expect(await grants(corpTeam)).toEqual([{ suspended_reason: null }]);
  });
});

describe("walls CSV and providers", () => {
  it("rejects a file with 12% unresolvable principals entirely", async () => {
    const rows = [["client_id", "matter_number", "principal_type", "principal", "effect"]];
    for (let i = 0; i < 22; i++) rows.push(["00456", "0001", "user", ana.email, "allow"]);
    for (let i = 0; i < 3; i++)
      rows.push(["00456", "0001", "user", `ghost${i}@nowhere.test`, "deny"]);
    const res = await upload(admin, "/admin/walls/import", csv(rows));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "TOO_MANY_UNRESOLVED", accepted: false, token: null });
    expect(res.body.unresolved).toHaveLength(3);
    const csvRows = await h.call(admin, "GET", "/admin/walls?filter[provider]=csv");
    expect(csvRows.body.items).toEqual([]);
  });

  it("evaluates internal and csv rows together, and deny from any provider wins", async () => {
    const file = csv([
      ["client_id", "matter_number", "principal_type", "principal", "effect"],
      ["00123", "0001", "user", ana.email.toUpperCase(), "deny"],
      ["00123", "0001", "group", "lit-team", "allow"],
    ]);
    const preview = await upload(admin, "/admin/walls/import", file);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ accepted: true, matters: 1, unchanged: 0 });
    expect(preview.body.add).toHaveLength(2);
    // Nothing changes until it is applied.
    expect((await evaluate(ana, m1)).reason).toBe("allowed");
    const applied = await h.call(admin, "POST", `/admin/walls/import/${preview.body.token}/apply`);
    expect(applied.body).toEqual({ matters: 1, add: 2, remove: 0 });

    const anaM1 = await evaluate(ana, m1);
    expect(anaM1).toMatchObject({ allowed: false, reason: "deny" });
    expect(anaM1.matched_rules.map((r: { provider: string }) => r.provider).sort()).toEqual([
      "csv",
      "internal",
    ]);
    expect((await evaluate(cal, m1)).reason).toBe("allowed");
    expect((await h.call(ana, "GET", `/vaults/${m1Vault}`)).status).toBe(404);

    // Full state per matter: the next file without Ana's deny removes it, internal rows stay.
    const next = await upload(
      admin,
      "/admin/walls/import",
      csv([
        ["client_id", "matter_number", "principal_type", "principal", "effect"],
        ["00123", "0001", "group", "lit-team", "allow"],
      ]),
    );
    expect(next.body.remove).toEqual([
      expect.objectContaining({ principal_type: "user", effect: "deny" }),
    ]);
    await h.call(admin, "POST", `/admin/walls/import/${next.body.token}/apply`);
    expect((await evaluate(ana, m1)).reason).toBe("allowed");
    const rows = (await h.call(admin, "GET", `/admin/walls?filter[matter_id]=${m1}`)).body.items;
    expect(rows.map((r: { provider: string }) => r.provider).sort()).toEqual([
      "csv",
      "internal",
      "internal",
    ]);

    // Synced rows aren't deleted by hand; a preview can't be applied twice.
    const csvRow = rows.find((r: { provider: string }) => r.provider === "csv");
    expect((await h.call(admin, "DELETE", `/admin/walls/${csvRow.id}`)).status).toBe(409);
    expect(
      (await h.call(admin, "POST", `/admin/walls/import/${next.body.token}/apply`)).status,
    ).toBe(409);

    const trail = await auditTrail(pool, admin.workspaceId);
    expect(trail.filter((e) => e.action === "wall.csv_applied")).toHaveLength(2);
    const syncs = await h.call(admin, "GET", "/admin/walls/provider/syncs");
    expect(syncs.body.items[0]).toMatchObject({ provider: "csv", status: "ok", rows_removed: 1 });
  });

  it("accepts internal and csv providers and refuses the reserved ones clearly", async () => {
    for (const kind of ["intapp", "imanage_spm"]) {
      const res = await h.call(admin, "PUT", "/admin/walls/provider", { kind });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("PROVIDER_NOT_SUPPORTED");
      expect(res.body.message).toContain(kind);
    }
    const ok = await h.call(admin, "PUT", "/admin/walls/provider", { kind: "csv" });
    expect(ok.status).toBe(200);
    expect((await h.call(admin, "GET", "/admin/walls/provider")).body.kind).toBe("csv");
    expect((await h.call(ana, "PUT", "/admin/walls/provider", { kind: "csv" })).status).toBe(403);
    const actions = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(actions).toContain("wall.provider_configured");
  });

  it("keeps wall rows and their admin endpoints from everyone else", async () => {
    expect((await h.call(cal, "GET", "/admin/walls")).status).toBe(403);
    expect(
      (
        await h.call(cal, "POST", "/admin/walls", {
          matter_id: m2,
          principal_type: "user",
          principal_id: cal.userId,
          effect: "allow",
        })
      ).status,
    ).toBe(403);
  });
});
