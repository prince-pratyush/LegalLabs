import { DEFAULT_MATTER_OPTIONS } from "@legallabs/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { matterHarness, type Person } from "../test-matters.js";
import { parseCsv, toCsv } from "./csv.js";

const pool = testPool();
afterAll(() => pool.end());
// Sign-ins are rate limited per app, so each test gets its own.
let h = matterHarness(pool);
beforeEach(() => {
  h = matterHarness(pool);
});

const ACME = {
  client_id: "00123",
  client_name: "Acme Corp",
  matter_number: "0001",
  matter_name: "Acme acquisition",
};

const setOptions = (admin: Person, patch: Partial<typeof DEFAULT_MATTER_OPTIONS>) =>
  h.call(admin, "PUT", "/admin/matters/options", { ...DEFAULT_MATTER_OPTIONS, ...patch });
const importCsv = (who: Person, content: string, mode = "upsert") =>
  h.postFile(who, "/matters/import", "matters.csv", content, { mode });

describe("csv", () => {
  it("reads quotes, embedded commas, newlines and CRLF", () => {
    const table = parseCsv('﻿A,B\r\n"x, ""y""","line\nbreak"\r\n\r\nz,\n', 10);
    expect(table.header).toEqual(["a", "b"]);
    expect(table.records).toEqual([
      { line: 2, values: ['x, "y"', "line\nbreak"] },
      { line: 5, values: ["z", ""] },
    ]);
  });

  it("refuses an unclosed quote and too many rows", () => {
    expect(() => parseCsv('a\n"open', 10)).toThrow(/never closed/);
    expect(() => parseCsv("a\n1\n2\n3", 2)).toThrow("TOO_MANY_ROWS");
  });

  it("writes quoted cells and defuses spreadsheet formulas", () => {
    expect(toCsv([["a,b", "=SUM(A1)", 'say "hi"']])).toBe('"a,b",\'=SUM(A1),"say ""hi"""\r\n');
  });
});

describe("SPC-006 matters", () => {
  it("formats display as {client_id}-{matter_number} with the client name", async () => {
    const admin = await h.workspace();
    expect(
      (
        await setOptions(admin, {
          display_format: { ...DEFAULT_MATTER_OPTIONS.display_format, show_client_name: true },
        })
      ).status,
    ).toBe(200);
    const created = await h.call(admin, "POST", "/matters", ACME);
    expect(created.status).toBe(201);
    expect(created.body.matter.display).toBe("00123-0001 Acme Corp");
    const listed = await h.call(admin, "GET", "/matters?q=acme");
    expect(listed.body.items[0].display).toBe("00123-0001 Acme Corp");
  });

  it("lists an id_regex miss under issues and leaves it out on apply", async () => {
    const admin = await h.workspace();
    await setOptions(admin, { id_regex: "^\\d{5}-\\d{4}$" });
    const file = [
      "client_id,client_name,matter_number,matter_name,notice",
      "00123,Acme,12345-0001,Deal,",
      "00123,Acme,ABC,Bad number,",
      "00124,Beta,12345-0002,Other,Read the conflict notice",
    ].join("\n");
    const preview = await importCsv(admin, file);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ add: 2, update: 0, close: 0, issue_count: 1 });
    expect(preview.body.issues).toEqual([
      { line: 3, column: "matter_number", message: expect.stringMatching(/id pattern/) },
    ]);

    const applied = await h.call(admin, "POST", `/matters/import/${preview.body.token}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toEqual({ add: 2, update: 0, close: 0 });
    expect(applied.body.report_csv).toContain("ABC,Bad number,,error:");
    const numbers = (await h.call(admin, "GET", "/matters")).body.items.map(
      (m: { matter_number: string }) => m.matter_number,
    );
    expect(numbers.sort()).toEqual(["12345-0001", "12345-0002"]);
    const report = await h.app.request(`/api/v1/matters/import/${preview.body.token}/report`, {
      headers: { cookie: admin.cookie },
    });
    expect(report.headers.get("content-type")).toContain("text/csv");
    expect(await report.text()).toContain("result");

    // A single matter is checked against the same pattern.
    const bad = await h.call(admin, "POST", "/matters", { ...ACME, matter_number: "ABC" });
    expect(bad.body.code).toBe("ID_REGEX_MISMATCH");
    const trail = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(trail).toEqual(expect.arrayContaining(["matter.options_updated", "matter.imported"]));
  });

  it("updates in place and closes rows missing from a replace file, never deleting", async () => {
    const admin = await h.workspace();
    const first = await importCsv(
      admin,
      "client_id,client_name,matter_number,matter_name\nC1,One,1,First\nC2,Two,2,Second\n",
    );
    await h.call(admin, "POST", `/matters/import/${first.body.token}/apply`);
    const second = await importCsv(
      admin,
      "client_id,client_name,matter_number,matter_name\nC1,One,1,First renamed\n",
      "replace_missing_as_closed",
    );
    expect(second.body).toMatchObject({ add: 0, update: 1, close: 1 });
    const applied = await h.call(admin, "POST", `/matters/import/${second.body.token}/apply`);
    expect(applied.body.applied).toEqual({ add: 0, update: 1, close: 1 });
    const items = (await h.call(admin, "GET", "/matters")).body.items;
    expect(
      items.map((m: { matter_name: string; status: string }) => [m.matter_name, m.status]),
    ).toEqual([
      ["First renamed", "active"],
      ["Second", "closed"],
    ]);
    // Closed matters stay listed for admins but leave the picker.
    const picker = (await h.call(admin, "GET", "/matters?scope=picker")).body.items;
    expect(picker.map((m: { matter_name: string }) => m.matter_name)).toEqual(["First renamed"]);
  });

  it("refuses a file without the required header, and imports by admins only", async () => {
    const admin = await h.workspace();
    const bad = await importCsv(admin, "client,matter\nA,B\n");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_CSV");
    const ana = await h.member(admin, "ana");
    const forbidden = await importCsv(
      ana,
      "client_id,client_name,matter_number,matter_name\nC1,One,1,First\n",
    );
    expect(forbidden.status).toBe(403);
  });

  it("shows a notice once, then again once after its text changes", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    const created = await h.call(admin, "POST", "/matters", {
      ...ACME,
      notice_md: "Conflict screen: do not discuss with the Beta team.",
    });
    const id = created.body.matter.id;
    const seen = async () => (await h.call(ana, "GET", `/matters/${id}`)).body.matter;

    expect(await seen()).toMatchObject({ acknowledged: false, notice_version: 1 });
    const ack = await h.call(ana, "POST", `/matters/${id}/acknowledge`);
    expect(ack.body).toMatchObject({ notice_version: 1 });
    expect((await seen()).acknowledged).toBe(true);

    // Saving the same text doesn't re-prompt anyone.
    await h.call(admin, "PATCH", `/matters/${id}`, {
      notice_md: "Conflict screen: do not discuss with the Beta team.",
    });
    expect((await seen()).acknowledged).toBe(true);

    const changed = await h.call(admin, "PATCH", `/matters/${id}`, {
      notice_md: "Updated: the Beta team now includes Gamma.",
    });
    expect(changed.body.matter.notice_version).toBe(2);
    expect(await seen()).toMatchObject({ acknowledged: false, notice_version: 2 });
    await h.call(ana, "POST", `/matters/${id}/acknowledge`);
    expect((await seen()).acknowledged).toBe(true);

    const list = await h.call(admin, "GET", `/matters/${id}/acknowledgements`);
    expect(list.body.items.map((a: { notice_version: number }) => a.notice_version)).toEqual([
      2, 1,
    ]);
    expect(list.body.items[0].email).toBe(ana.email);
    expect((await h.call(ana, "GET", `/matters/${id}/acknowledgements`)).status).toBe(403);
    const trail = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(trail.filter((a) => a === "matter.notice_acknowledged")).toHaveLength(2);
    expect(trail).toContain("matter.updated");
  });

  it("refuses a question without a matter when require_for_queries is on", async () => {
    const admin = await h.workspace();
    await setOptions(admin, { require_for_queries: true });
    const res = await h.call(admin, "POST", "/threads", {
      content: "What is the governing law?",
      scope: { document_ids: [], vault_ids: [], sources: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MATTER_REQUIRED");
  });

  it("refuses a vault without a matter when vault_association is required", async () => {
    const admin = await h.workspace();
    await setOptions(admin, { vault_association: "required" });
    const res = await h.call(admin, "POST", "/vaults", { name: "Loose files" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MATTER_REQUIRED_FOR_VAULT");
    const matter = await h.call(admin, "POST", "/matters", ACME);
    const ok = await h.call(admin, "POST", "/vaults", {
      name: "Deal files",
      matter_id: matter.body.matter.id,
    });
    expect(ok.status).toBe(201);
    await setOptions(admin, { vault_association: "disabled" });
    const disabled = await h.call(admin, "POST", "/vaults", {
      name: "Deal files 2",
      matter_id: matter.body.matter.id,
    });
    expect(disabled.body.code).toBe("MATTER_NOT_ALLOWED_FOR_VAULT");
  });

  it("lets members create and edit their own matters only when user_editable", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    expect((await h.call(ana, "POST", "/matters", ACME)).status).toBe(403);
    expect(
      (await h.call(ana, "PUT", "/admin/matters/options", DEFAULT_MATTER_OPTIONS)).status,
    ).toBe(403);
    await setOptions(admin, { user_editable: true });
    const own = await h.call(ana, "POST", "/matters", ACME);
    expect(own.status).toBe(201);
    expect(own.body.matter).toMatchObject({ source: "manual", display: "00123-0001" });
    expect(own.body.matter.walls_count).toBeUndefined();
    const renamed = await h.call(ana, "PATCH", `/matters/${own.body.matter.id}`, {
      matter_name: "Renamed",
    });
    expect(renamed.body.matter.matter_name).toBe("Renamed");
    const theirs = await h.call(admin, "POST", "/matters", { ...ACME, matter_number: "0002" });
    const edit = await h.call(ana, "PATCH", `/matters/${theirs.body.matter.id}`, {
      matter_name: "Mine now",
    });
    expect(edit.status).toBe(403);
    expect((await h.call(admin, "POST", "/matters", ACME)).body.code).toBe("MATTER_EXISTS");
  });

  it("closes a matter, audits it, and keeps it out of the picker", async () => {
    const admin = await h.workspace();
    const created = await h.call(admin, "POST", "/matters", ACME);
    const id = created.body.matter.id;
    const closed = await h.call(admin, "POST", `/matters/${id}/close`);
    expect(closed.body.matter.status).toBe("closed");
    expect((await h.call(admin, "GET", "/matters?scope=picker")).body.items).toEqual([]);
    expect((await h.call(admin, "GET", `/matters/${id}`)).status).toBe(200);
    const trail = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(trail).toEqual(expect.arrayContaining(["matter.created", "matter.closed"]));
  });

  it("remembers the session's current matter, but only one the caller can reach", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    const created = await h.call(admin, "POST", "/matters", ACME);
    const id = created.body.matter.id;
    expect((await h.call(ana, "PUT", "/matters/current", { matter_id: id })).status).toBe(200);
    expect((await h.call(ana, "GET", "/matters/current")).body.matter.id).toBe(id);
    await h.call(admin, "POST", "/admin/walls", {
      matter_id: id,
      principal_type: "user",
      principal_id: ana.userId,
      effect: "deny",
    });
    expect((await h.call(ana, "GET", "/matters/current")).body.matter).toBeNull();
    expect((await h.call(ana, "PUT", "/matters/current", { matter_id: id })).status).toBe(404);
  });
});
