import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { matterHarness, type Person } from "../test-matters.js";
import { emailEml } from "./message.js";

const pool = testPool();
afterAll(() => pool.end());
const h = matterHarness(pool);

const ITEM = {
  item_id: "AAMk-1",
  subject: "Lease / notice: “urgent”",
  from: "them@acme.test",
  to: ["me@firm.test"],
  cc: [],
  date: "2026-03-02T10:00:00.000Z",
  body_text: "The notice must be served by 4 March.",
};

const pane = (who: Person) => ({
  authorization: `Bearer ${who.cookie.split("=")[1]}`,
  "x-legallabs-client": "outlook",
});

async function post(who: Person, path: string, body: FormData | object) {
  const form = body instanceof FormData;
  const res = await h.app.request(`/api/v1/addins/outlook${path}`, {
    method: "POST",
    headers: { ...pane(who), ...(form ? {} : { "content-type": "application/json" }) },
    body: form ? body : JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: tests read loosely typed JSON bodies.
  return { status: res.status, body: (await res.json()) as any };
}

function email(fields: Record<string, string> = {}, attachments: File[] = [], item: object = ITEM) {
  const data = new FormData();
  data.set("item", JSON.stringify(item));
  for (const attachment of attachments) data.append("attachment", attachment);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** An Outlook thread of the person's with one answer in it, as a run would leave it. */
async function answered(who: Person, content: string) {
  const made = await post(who, "/items", email());
  expect(made.status).toBe(201);
  const threadId = made.body.thread_id as string;
  const { rows } = await pool.query<{ id: string }>(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'assistant', $3) returning id`,
    [who.workspaceId, threadId, content],
  );
  return { thread_id: threadId, message_id: rows[0]?.id ?? "" };
}

async function vault(owner: Person, name: string, body: Record<string, unknown> = {}) {
  const made = await h.call(owner, "POST", "/vaults", { name, ...body });
  expect(made.status).toBe(201);
  return made.body.vault.id as string;
}

const share = async (owner: Person, vaultId: string, who: Person, level: string) =>
  expect(
    (
      await h.call(owner, "PUT", `/vaults/${vaultId}/shares`, {
        grants: [{ principal_type: "user", principal_id: who.userId, level }],
        workspace_view: false,
      })
    ).status,
  ).toBe(200);

describe("preparing a reply", () => {
  it("turns an answer into inert HTML with no addresses, and stores no draft", async () => {
    const ana = await h.workspace();
    const ids = await answered(
      ana,
      'Dear Sam,\n\nWe will serve it by 4 March.[[c:1]] See https://evil.test/x?d=1 or www.evil.test.\n<img src=x onerror="alert(1)">\nA & B',
    );
    const res = await post(ana, "/drafts", ids);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      body_html:
        "<p>Dear Sam,</p><p>We will serve it by 4 March. See [link removed] or [link removed]<br>" +
        "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br>A &amp; B</p>",
    });
    const trail = await auditTrail(pool, ana.workspaceId);
    expect(trail.at(-1)).toMatchObject({
      action: "mail.draft_prepared",
      object_id: ids.thread_id,
      details: { message_id: ids.message_id },
    });
    expect(JSON.stringify(trail)).not.toContain("Dear Sam");
  });

  it("is only for the owner of an Outlook thread, and only for an answer", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    const ids = await answered(ana, "Yes.");
    expect((await post(admin, "/drafts", ids)).status).toBe(404);
    const unknown = { ...ids, message_id: crypto.randomUUID() };
    expect((await post(ana, "/drafts", unknown)).status).toBe(404);
    expect((await post(ana, "/drafts", { thread_id: "x" })).status).toBe(400);
    await pool.query("update work.thread set surface = 'web' where id = $1", [ids.thread_id]);
    expect((await post(ana, "/drafts", ids)).status).toBe(404);
  });

  it("refuses when a source's vault forbids copies", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    const locked = await vault(admin, "Locked");
    const added = await h.postFile(admin, `/vaults/${locked}/files`, "secret.txt", "Secret terms.");
    await share(admin, locked, ana, "view");
    expect(
      (
        await h.call(admin, "PATCH", `/vaults/${locked}`, {
          content_controls: {
            allow_download: false,
            allow_duplicate: true,
            show_review_prompts: false,
          },
        })
      ).status,
    ).toBe(200);

    const cited = await answered(ana, "The terms are secret.");
    await pool.query(
      `insert into work.thread_document (workspace_id, thread_id, version_id) values ($1, $2, $3)`,
      [ana.workspaceId, cited.thread_id, added.body.file.version_id],
    );
    const refused = await post(ana, "/drafts", cited);
    expect([refused.status, refused.body.code]).toEqual([403, "COPY_DISABLED"]);

    // Searched but not cited: the vault is still part of the thread.
    const searched = await answered(ana, "The terms are secret.");
    await pool.query("update work.thread set vault_ids = $2 where id = $1", [
      searched.thread_id,
      [locked],
    ]);
    expect((await post(ana, "/drafts", searched)).status).toBe(403);
  });
});

describe("saving an email to a vault", () => {
  it("keeps the message and its attachments in a folder named for it", async () => {
    const ana = await h.workspace();
    const target = await vault(ana, "Deal");
    const res = await post(
      ana,
      "/save-to-vault",
      email({ vault_id: target }, [new File(["Rent terms."], "Lease.txt")]),
    );
    expect(res.status).toBe(201);
    expect(res.body.folder_name).toBe("2026-03-02 Lease notice “urgent”");
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual([
      "Lease notice “urgent”.txt",
      "Lease.txt",
    ]);
    const tree = await h.call(ana, "GET", `/vaults/${target}/tree?folder_id=${res.body.folder_id}`);
    expect(tree.body.files).toHaveLength(2);
    const trail = await auditTrail(pool, ana.workspaceId);
    expect(trail.find((e) => e.action === "mail.saved_to_vault")).toMatchObject({
      object_id: target,
      details: { count: 2, folder_id: res.body.folder_id },
    });
    expect(JSON.stringify(trail)).not.toContain("urgent");
  });

  it("follows the vault's permissions and the matter's walls", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    const mine = await vault(admin, "Admin only");
    const save = (vaultId: string) => post(ana, "/save-to-vault", email({ vault_id: vaultId }));
    expect((await save(mine)).status).toBe(404);
    await share(admin, mine, ana, "view");
    expect((await save(mine)).status).toBe(403);

    const matter = (
      await h.call(admin, "POST", "/matters", {
        client_id: "1",
        client_name: "Acme",
        matter_number: "0001",
        matter_name: "Deal",
      })
    ).body.matter.id;
    const walled = await vault(admin, "Matter vault", { matter_id: matter });
    await share(admin, walled, ana, "edit");
    await h.call(admin, "POST", "/admin/walls", {
      matter_id: matter,
      principal_type: "user",
      principal_id: ana.userId,
      effect: "deny",
    });
    expect((await save(walled)).status).toBe(404);
    const { rows } = await pool.query(
      "select 1 from content.folder where vault_id = any($1::uuid[])",
      [[mine, walled]],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("the .eml kept when email files can be read", () => {
  it("encodes what the sender wrote so none of it becomes a header", () => {
    const eml = emailEml({
      ...ITEM,
      subject: "Hi\r\nBcc: spy@evil.test é".repeat(4),
      from: "a@b.test\r\nX-Injected: 1",
      body_text: "line one\n\nline two é",
    });
    const [head = "", body = ""] = eml.split("\r\n\r\n");
    expect(head).not.toMatch(/^(Bcc|X-Injected):/m);
    expect(head.split("\r\n").every((line) => line.length <= 998)).toBe(true);
    expect(head).toContain("Date: Mon, 02 Mar 2026 10:00:00 +0000");
    expect(head).toContain("Subject: =?utf-8?B?");
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe(
      "line one\r\n\r\nline two é",
    );
  });
});
