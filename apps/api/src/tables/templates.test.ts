import { afterAll, describe, expect, it } from "vitest";
import { auditTrail } from "../test-db.js";
import { colleague, LAW, pool, setup } from "../test-tables.js";

afterAll(() => pool.end());

type S = Awaited<ReturnType<typeof setup>>;

const call = (s: S, method: string, path: string, body?: unknown, cookie = s.cookie) =>
  s.h.call(cookie, method, path, body);

/** A table with two columns, the second built on the first, and its own instructions. */
async function dealTable() {
  const s = await setup();
  const law = (await call(s, "POST", `/review-tables/${s.tableId}/columns`, LAW)).body.column.id;
  await call(s, "POST", `/review-tables/${s.tableId}/columns`, {
    label: "Position",
    type: "free",
    prompt: `Is @{${law}} usual?`,
  });
  await call(s, "PATCH", `/review-tables/${s.tableId}`, {
    instructions: "Be brief.",
    settings: { date_format: "DMY" },
  });
  return s;
}

const save = (s: S, body: object = {}) =>
  call(s, "POST", `/review-tables/${s.tableId}/templates`, {
    name: "Deal terms",
    description: "Governing law and position",
    categories: ["Finance"],
    document_tags: ["credit agreement"],
    ...body,
  });

describe("review-table templates (RVT-009)", () => {
  it("saves a table's columns and settings, never its rows (RVT-009)", async () => {
    const s = await dealTable();
    const saved = await save(s);
    expect(saved.status).toBe(201);
    const t = saved.body.template;
    expect(t).toMatchObject({
      name: "Deal terms",
      status: "draft",
      version: 1,
      builtin: false,
      instructions: "Be brief.",
      categories: ["Finance"],
      my_access: "owner",
    });
    expect(t.settings.date_format).toBe("DMY");
    expect(t.columns.map((c: { key: string; label: string }) => [c.key, c.label])).toEqual([
      ["c1", "Governing law"],
      ["c2", "Position"],
    ]);
    // The reference to another column is kept by key, so it survives the copy.
    expect(t.columns[1].prompt).toBe("Is @{c1} usual?");
    expect(JSON.stringify(t)).not.toMatch(/credit\.txt|lease\.txt/);
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.some((e) => e.action === "template.created" && e.details.columns === 2)).toBe(
      true,
    );
  });

  it("creates a table from a template with the columns, wired to each other", async () => {
    const s = await dealTable();
    const t = (await save(s)).body.template;
    const created = await call(s, "POST", "/review-tables", {
      name: "From template",
      template_id: t.id,
      source: { kind: "vault", vault_id: s.v.id },
    });
    expect(created.status).toBe(201);
    const { table, columns } = created.body;
    expect(table.instructions).toBe("Be brief.");
    expect(table.settings.date_format).toBe("DMY");
    expect(columns.map((c: { label: string; state: string }) => [c.label, c.state])).toEqual([
      ["Governing law", "pending"],
      ["Position", "pending"],
    ]);
    // The second column now refers to the new table's own first column.
    expect(columns[1].depends_on).toEqual([columns[0].id]);
    expect(columns[1].prompt).toBe(`Is @{${columns[0].id}} usual?`);
    // Nothing ran: a new table's columns wait for Run.
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.some((e) => e.action === "template.used")).toBe(true);
    expect((await call(s, "GET", `/review-tables/${table.id}`)).body.table.stats.cells_done).toBe(
      0,
    );
  });

  it("refuses a template that isn't there", async () => {
    const s = await dealTable();
    const missing = await call(s, "POST", "/review-tables", {
      template_id: "0194f3a0-0000-7000-8000-00000000dead",
      source: { kind: "vault", vault_id: s.v.id },
    });
    expect(missing).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  });

  it("is private until shared, then readable but not editable by the person it's shared with", async () => {
    const s = await dealTable();
    const t = (await save(s)).body.template;
    const ben = await s.h.signIn(await colleague(s.m, "{threads.use,tables.create}"));
    expect((await call(s, "GET", `/review-table-templates/${t.id}`, undefined, ben)).status).toBe(
      404,
    );
    expect((await call(s, "GET", "/review-table-templates", undefined, ben)).body.items).toEqual(
      [],
    );

    const benUser = (
      await pool.query<{ id: string }>(
        `select id from core."user" where workspace_id = $1 and email like 'ben-%' order by created_at desc limit 1`,
        [s.m.workspaceId],
      )
    ).rows[0]?.id;
    const shared = await call(s, "PUT", `/review-table-templates/${t.id}/shares`, {
      grants: [{ principal_type: "user", principal_id: benUser, level: "use" }],
    });
    expect(shared.status).toBe(200);
    expect(shared.body.shares[0]).toMatchObject({ principal_id: benUser, level: "use" });
    expect(
      (await call(s, "GET", `/review-table-templates/${t.id}`, undefined, ben)).body.template,
    ).toMatchObject({ status: "draft", my_access: "use" });
    expect(
      await call(s, "PATCH", `/review-table-templates/${t.id}`, { name: "Mine" }, ben),
    ).toMatchObject({ status: 403 });
    // Only the owner shares onward.
    expect(
      (await call(s, "PUT", `/review-table-templates/${t.id}/shares`, { grants: [] }, ben)).status,
    ).toBe(403);
    // Sharing with a person who isn't a member is refused.
    expect(
      (
        await call(s, "PUT", `/review-table-templates/${t.id}/shares`, {
          grants: [
            {
              principal_type: "user",
              principal_id: "0194f3a0-0000-7000-8000-00000000dead",
              level: "use",
            },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it("goes from draft to tested to approved, and only a manager approves (RVT-009)", async () => {
    const s = await dealTable();
    const author = await s.h.signIn(await colleague(s.m, "{threads.use,tables.create}"));
    const t = (await save(s)).body.template;

    // Not tested yet, so it can't be sent for approval.
    expect(await call(s, "POST", `/review-table-templates/${t.id}/publish`)).toMatchObject({
      status: 409,
      body: { code: "TEMPLATE_BAD_TRANSITION" },
    });
    // Try it on a file: a throwaway table, columns started on it, and the template is tested.
    const tried = await call(s, "POST", `/review-table-templates/${t.id}/test`, {
      vault_id: s.v.id,
      document_ids: [s.v.ids[0]],
    });
    expect(tried.status).toBe(202);
    await s.h.tables.runner.idle();
    const testTable = await call(s, "GET", `/review-tables/${tried.body.table_id}`);
    expect(testTable.body.table.stats.rows).toBe(1);
    expect((await call(s, "GET", `/review-table-templates/${t.id}`)).body.template.status).toBe(
      "tested",
    );

    const pending = await call(s, "POST", `/review-table-templates/${t.id}/publish`);
    expect(pending).toMatchObject({ status: 202, body: { status: "pending_approval" } });
    // The author isn't a manager, so they can't approve or reject.
    expect(
      (await call(s, "POST", `/admin/review-table-templates/${t.id}/approve`, {}, author)).status,
    ).toBe(404);
    const rejected = await call(s, "POST", `/admin/review-table-templates/${t.id}/reject`, {
      note: "Needs a clearer prompt",
    });
    expect(rejected.body.template).toMatchObject({
      status: "rejected",
      rejected_note: "Needs a clearer prompt",
    });
    // Back to the author's court: test again, ask again, and it is approved.
    await call(s, "POST", `/review-table-templates/${t.id}/test`, {
      vault_id: s.v.id,
      document_ids: [s.v.ids[0]],
    });
    await s.h.tables.runner.idle();
    await call(s, "POST", `/review-table-templates/${t.id}/publish`);
    const approved = await call(s, "POST", `/admin/review-table-templates/${t.id}/approve`, {});
    expect(approved.body.template.status).toBe("published");

    // Published, so everyone in the workspace sees it in the list.
    const cal = await s.h.signIn(await colleague(s.m, "{threads.use}"));
    const listed = await call(
      s,
      "GET",
      "/review-table-templates?filter[status]=published",
      undefined,
      cal,
    );
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([t.id]);

    const trail = await auditTrail(pool, s.m.workspaceId);
    for (const action of [
      "template.tested",
      "template.publish_requested",
      "template.rejected",
      "template.approved",
    ]) {
      expect(trail.some((e) => e.action === action)).toBe(true);
    }
  });

  it("editing a published template makes a new draft and keeps the old one serving", async () => {
    const s = await dealTable();
    const t = (await save(s)).body.template;
    await call(s, "POST", `/review-table-templates/${t.id}/test`, {
      vault_id: s.v.id,
      document_ids: [s.v.ids[0]],
    });
    await s.h.tables.runner.idle();
    await call(s, "POST", `/review-table-templates/${t.id}/publish`);
    await call(s, "POST", `/admin/review-table-templates/${t.id}/approve`, {});

    const edited = await call(s, "PATCH", `/review-table-templates/${t.id}`, {
      name: "Deal terms v2",
    });
    expect(edited.body.template).toMatchObject({
      name: "Deal terms v2",
      version: 2,
      status: "draft",
      parent_id: t.id,
    });
    expect((await call(s, "GET", `/review-table-templates/${t.id}`)).body.template).toMatchObject({
      name: "Deal terms",
      status: "published",
    });
    // Approving the new version retires the old one.
    const next = edited.body.template.id as string;
    await call(s, "POST", `/review-table-templates/${next}/test`, {
      vault_id: s.v.id,
      document_ids: [s.v.ids[0]],
    });
    await s.h.tables.runner.idle();
    await call(s, "POST", `/review-table-templates/${next}/publish`);
    await call(s, "POST", `/admin/review-table-templates/${next}/approve`, {});
    const listed = await call(s, "GET", "/review-table-templates?filter[status]=published");
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([next]);
  });

  it("sends a tested template back to draft when its columns change, and 404s a bad id", async () => {
    const s = await dealTable();
    const t = (await save(s)).body.template;
    await call(s, "POST", `/review-table-templates/${t.id}/test`, {
      vault_id: s.v.id,
      document_ids: [s.v.ids[0]],
    });
    await s.h.tables.runner.idle();
    expect((await call(s, "GET", `/review-table-templates/${t.id}`)).body.template.status).toBe(
      "tested",
    );
    const edited = await call(s, "PATCH", `/review-table-templates/${t.id}`, {
      columns: [{ key: "c1", label: "Only", type: "free", prompt: "What?", options: {} }],
    });
    expect(edited.body.template.status).toBe("draft");
    // A name change isn't a change of content.
    await call(s, "POST", `/review-table-templates/${t.id}/test`, {
      vault_id: s.v.id,
      document_ids: [s.v.ids[0]],
    });
    await s.h.tables.runner.idle();
    const renamed = await call(s, "PATCH", `/review-table-templates/${t.id}`, { name: "Renamed" });
    expect(renamed.body.template.status).toBe("tested");
    // The options have to fit the type.
    const bad = await call(s, "PATCH", `/review-table-templates/${t.id}`, {
      columns: [{ key: "c1", label: "X", type: "classify", prompt: "?", options: { options: [] } }],
    });
    expect(bad).toMatchObject({ status: 400, body: { code: "TEMPLATE_INVALID" } });
    for (const path of ["publish", "shares"]) {
      const res = await call(
        s,
        path === "shares" ? "PUT" : "POST",
        `/review-table-templates/xyz/${path}`,
        path === "shares" ? { grants: [] } : undefined,
      );
      expect(res.status).toBe(404);
    }
    expect((await call(s, "POST", "/admin/review-table-templates/xyz/approve", {})).status).toBe(
      404,
    );
  });

  it("edits columns, refuses a circle, and deletes", async () => {
    const s = await dealTable();
    const t = (await save(s)).body.template;
    const circle = await call(s, "PATCH", `/review-table-templates/${t.id}`, {
      columns: [
        { key: "c1", label: "A", type: "free", prompt: "Uses @{c2}", options: {} },
        { key: "c2", label: "B", type: "free", prompt: "Uses @{c1}", options: {} },
      ],
    });
    expect(circle).toMatchObject({ status: 400, body: { code: "TEMPLATE_INVALID" } });
    const fine = await call(s, "PATCH", `/review-table-templates/${t.id}`, {
      columns: [{ key: "c1", label: "Only", type: "free", prompt: "What?", options: {} }],
      categories: ["Real estate"],
    });
    expect(fine.body.template.columns).toHaveLength(1);
    expect(fine.body.template.categories).toEqual(["Real estate"]);
    expect((await call(s, "DELETE", `/review-table-templates/${t.id}`)).status).toBe(204);
    expect((await call(s, "GET", `/review-table-templates/${t.id}`)).status).toBe(404);
  });
});
