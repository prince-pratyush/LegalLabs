import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const EMIT = `select * from notify.emit('thread.shared', 'threads', $1, $2, 'Title', null, $3, false,
  $4::jsonb, $5, $6, $7::uuid[])`;

// Emits as `runner`, naming `actor` (null for a system event).
async function emit(
  tx: Tx,
  s: Seed,
  runner: string,
  o: {
    type: string;
    id: string;
    to: string[];
    actor?: string | null;
    actions?: unknown;
    url?: string;
    matter?: string | null;
  },
) {
  await tx.as(runner, s.acme);
  return tx.rows<{ user_id: string }>(EMIT, [
    o.type,
    o.id,
    o.actor === undefined ? null : o.actor,
    JSON.stringify(o.actions ?? []),
    o.url ?? "#/t/x",
    o.matter ?? null,
    o.to,
  ]);
}

const who = (rows: { user_id: string }[]) => rows.map((r) => r.user_id).sort();

describe("notification links", () => {
  it("accept in-app paths only, in emit and in the table itself", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      for (const url of ["#/t/1", "/t/1", "#/", "/"]) {
        const out = await emit(tx, s, s.ana, { type: "task", id: randomUUID(), to: [s.ben], url });
        expect(who(out), url).toEqual([s.ben]);
      }
      for (const url of [
        "//evil.example/x",
        "https://evil.example",
        "javascript:alert(1)",
        "/\\evil.example",
        "#evil",
        "t/1",
        "/a b",
        "",
        `/${"x".repeat(600)}`,
      ]) {
        await tx.as(s.ana, s.acme);
        const err = await tx.error(EMIT, ["task", randomUUID(), null, "[]", url, null, [s.ben]]);
        expect(err, url).toMatch(/INVALID_URL/);
      }
      await tx.asOwner();
      expect(
        await tx.error(
          `insert into notify.notification (workspace_id, user_id, kind, category, object_type,
             object_id, title, url) values ($1, $2, 'thread.shared', 'threads', 'task', $3, 't', 'https://x.example')`,
          [s.acme, s.ben, randomUUID()],
        ),
      ).toMatch(/notification_url_app_path/);
    });
  });
});

describe("notification actions", () => {
  const ok = [
    [],
    [{ id: "open", label: "Open", style: "secondary" }],
    [
      { id: "accept", label: "Accept", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
  ];
  const bad: [string, unknown][] = [
    ["an object", { id: "a", label: "A", style: "primary" }],
    ["a string", "open"],
    [
      "too many",
      Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: "A", style: "primary" })),
    ],
    ["an unknown style", [{ id: "a", label: "A", style: "rainbow" }]],
    ["a missing label", [{ id: "a", style: "primary" }]],
    ["an extra key", [{ id: "a", label: "A", style: "primary", href: "https://x.example" }]],
    ["a long label", [{ id: "a", label: "x".repeat(61), style: "primary" }]],
    ["an empty id", [{ id: "", label: "A", style: "primary" }]],
    ["a non-string id", [{ id: 4, label: "A", style: "primary" }]],
    ["a bare element", ["open"]],
  ];

  it("accept a short list of id, label and style", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      for (const actions of ok) {
        const out = await emit(tx, s, s.ana, {
          type: "task",
          id: randomUUID(),
          to: [s.ben],
          actions,
        });
        expect(who(out)).toEqual([s.ben]);
      }
    });
  });

  it("refuse anything else, and write nothing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      for (const [name, actions] of bad) {
        await tx.as(s.ana, s.acme);
        const err = await tx.error(EMIT, [
          "task",
          randomUUID(),
          null,
          JSON.stringify(actions),
          "#/t/x",
          null,
          [s.ben],
        ]);
        expect(err, name).toMatch(/INVALID_ACTIONS/);
      }
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select 1 from notify.notification")).toHaveLength(0);
    });
  });

  it("are checked by the table too", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      expect(
        await tx.error(
          `insert into notify.notification (workspace_id, user_id, kind, category, object_type,
             object_id, title, url, actions)
           values ($1, $2, 'thread.shared', 'threads', 'task', $3, 't', '#/x', '[{"id":"a"}]')`,
          [s.acme, s.ben, randomUUID()],
        ),
      ).toMatch(/notification_actions_valid/);
    });
  });
});

describe("notify.emit visibility", () => {
  const grant = async (tx: Tx, s: Seed, type: string, id: string, user: string) => {
    await tx.asOwner();
    await tx.rows(
      `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
         principal_id, level, granted_by) values ($1, $2, $3, 'user', $4, 'view', $5)`,
      [s.acme, type, id, user, s.ana],
    );
  };

  it("skips a recipient who cannot open the thread, and its runs", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, runId } = s.threads.acme;
      const to = [s.ana, s.ben, s.cal];
      // Only the owner sees an unshared thread.
      expect(who(await emit(tx, s, s.dee, { type: "thread", id: threadId, to }))).toEqual([s.ana]);
      expect(who(await emit(tx, s, s.dee, { type: "run", id: runId, to }))).toEqual([s.ana]);
      await grant(tx, s, "thread", threadId, s.cal);
      expect(who(await emit(tx, s, s.dee, { type: "thread", id: threadId, to }))).toEqual(
        [s.ana, s.cal].sort(),
      );
      expect(who(await emit(tx, s, s.dee, { type: "run", id: runId, to }))).toEqual(
        [s.ana, s.cal].sort(),
      );
    });
  });

  it("skips a recipient who cannot open the vault", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { vaultId } = s.vaults.acme;
      const to = [s.ana, s.ben, s.cal, s.dee];
      expect(
        who(await emit(tx, s, s.dee, { type: "vault", id: vaultId, to: [s.ben, s.cal] })),
      ).toEqual([]);
      await grant(tx, s, "vault", vaultId, s.ben);
      const out = await emit(tx, s, s.dee, { type: "vault", id: vaultId, to });
      expect(who(out)).toEqual([s.ana, s.ben].sort());
    });
  });

  it("skips a recipient who cannot open the table or playbook", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const to = [s.ana, s.ben, s.cal];
      const table = await emit(tx, s, s.dee, {
        type: "table",
        id: s.reviewTables.acme.tableId,
        to,
      });
      expect(who(table)).toEqual([s.ana]);
      const playbook = await emit(tx, s, s.dee, {
        type: "playbook",
        id: s.playbooks.acme.playbookId,
        to,
      });
      expect(who(playbook)).toEqual([s.ana]);
    });
  });

  it("gives no row for an object that does not exist, or one in another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        who(await emit(tx, s, s.ana, { type: "thread", id: randomUUID(), to: [s.ben] })),
      ).toEqual([]);
      expect(
        who(await emit(tx, s, s.ana, { type: "thread", id: s.threads.beta.threadId, to: [s.ana] })),
      ).toEqual([]);
    });
  });

  it("leaves other object types alone and checks the wall as well", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        who(await emit(tx, s, s.ana, { type: "task", id: randomUUID(), to: [s.ben] })),
      ).toEqual([s.ben]);
      const { threadId } = s.threads.acme;
      await grant(tx, s, "thread", threadId, s.cal);
      // m2 denies Cal, so a shared thread still stays out of his inbox.
      expect(
        who(
          await emit(tx, s, s.dee, {
            type: "thread",
            id: threadId,
            to: [s.cal],
            matter: s.matters.m2,
          }),
        ),
      ).toEqual([]);
    });
  });

  it("restores the caller's identity after checking someone else's", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await emit(tx, s, s.ben, { type: "thread", id: s.threads.acme.threadId, to: [s.ana] });
      const me = await tx.one<{ me: string }>("select core.current_user_id() me");
      expect(me.me).toBe(s.ben);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("select notify.can_see($1, 'thread', $2)", [s.ana, randomUUID()]),
      ).toMatch(/permission denied/);
    });
  });
});

describe("memory.message_use ownership", () => {
  it("can be written only for a message in the caller's own thread", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { messageId } = s.threads.acme; // Ana's thread
      const insert = (user: string) =>
        tx.error(
          "insert into memory.message_use (message_id, workspace_id, user_id) values ($1, $2, $3)",
          [messageId, s.acme, user],
        );
      // Ben can't plant provenance on Ana's message, nor write it in her name.
      await tx.as(s.ben, s.acme);
      expect(await insert(s.ben)).toMatch(/row-level security/);
      expect(await insert(s.ana)).toMatch(/row-level security/);
      await tx.as(s.ana, s.acme);
      expect(await insert(s.ana)).toBeUndefined();
      // Moving a row onto someone else's message is refused too.
      await tx.asOwner();
      const other = await tx.one<{ id: string }>(
        `insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 't') returning id`,
        [s.acme, s.ben],
      );
      const msg = await tx.one<{ id: string }>(
        `insert into work.message (workspace_id, thread_id, role, content)
         values ($1, $2, 'assistant', 'hi') returning id`,
        [s.acme, other.id],
      );
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update memory.message_use set message_id = $1 where message_id = $2", [
          msg.id,
          messageId,
        ]),
      ).toMatch(/row-level security|violates|foreign key/);
    });
  });
});

const hash = (text: string) => createHash("sha256").update(text.toLowerCase()).digest("hex");

describe("shared writing styles and admins", () => {
  const style = async (tx: Tx, s: Seed, owner: string, shared: boolean) => {
    await tx.as(owner, s.acme);
    const row = await tx.one<{ id: string }>(
      `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
       values ($1, $2, 'Terse', 'instructions', 'Short.') returning id`,
      [s.acme, owner],
    );
    if (shared) {
      await tx.asOwner();
      await tx.rows("update memory.writing_style set shared = true where id = $1", [row.id]);
    }
    return row.id;
  };
  const read = async (tx: Tx, id: string) =>
    tx.rows<{ name: string; instructions: string; owner_id: string; shared: boolean }>(
      "select name, instructions, owner_id, shared from memory.writing_style where id = $1",
      [id],
    );

  it("can be edited by a workspace admin, but only while shared and never re-owned", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const shared = await style(tx, s, s.ben, true);
      const priv = await style(tx, s, s.cal, false);
      await tx.as(s.ana, s.acme); // the '*' role holds admin.config
      expect(
        await tx.rows(
          "update memory.writing_style set name = 'Edited', instructions = 'Long.' where id = $1 returning id",
          [shared],
        ),
      ).toHaveLength(1);
      expect(await read(tx, shared)).toMatchObject([
        { name: "Edited", instructions: "Long.", owner_id: s.ben, shared: true },
      ]);
      // A private style is not the admin's to touch, and ownership can't move.
      expect(
        await tx.rows("update memory.writing_style set name = 'x' where id = $1 returning id", [
          priv,
        ]),
      ).toHaveLength(0);
      expect(
        await tx.error("update memory.writing_style set owner_id = $1 where id = $2", [
          s.ana,
          shared,
        ]),
      ).toMatch(/permission denied/);
    });
  });

  it("can't be edited by an ordinary member or by other admin permissions", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const shared = await style(tx, s, s.ben, true);
      for (const user of [s.cal, s.dee]) {
        await tx.as(user, s.acme);
        expect(
          await tx.rows("update memory.writing_style set name = 'x' where id = $1 returning id", [
            shared,
          ]),
        ).toHaveLength(0);
      }
      await tx.as(s.ben, s.acme);
      expect((await read(tx, shared))[0]?.name).toBe("Terse");
    });
  });

  it("can be edited by a holder of admin.config alone, without sharing rights", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const shared = await style(tx, s, s.ben, true);
      await tx.asOwner();
      await tx.rows(
        `update core."user" set extra_permissions = array['admin.config'] where id = $1`,
        [s.dee],
      );
      await tx.as(s.dee, s.acme);
      expect(
        await tx.rows("update memory.writing_style set name = 'x' where id = $1 returning id", [
          shared,
        ]),
      ).toHaveLength(1);
      // Still no way to make a private style shared by owning it without writing_styles.share.
      const mine = await style(tx, s, s.dee, false);
      await tx.as(s.dee, s.acme);
      expect(
        await tx.error("update memory.writing_style set shared = true where id = $1", [mine]),
      ).toMatch(/row-level security/);
    });
  });

  it("never opens anyone's memory to an admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows(
        `update core."user" set extra_permissions = array['memory.use'] where id = $1`,
        [s.ben],
      );
      await tx.as(s.ben, s.acme);
      const mem = await tx.one<{ id: string }>(
        `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
         values ($1, $2, 'Prefers UK spelling', 'manual', $3) returning id`,
        [s.acme, s.ben, hash("Prefers UK spelling")],
      );
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select 1 from memory.memory where id = $1", [mem.id])).toHaveLength(0);
      expect(
        await tx.rows("update memory.memory set text = 'x' where id = $1 returning id", [mem.id]),
      ).toHaveLength(0);
      expect(
        await tx.rows("delete from memory.memory where id = $1 returning id", [mem.id]),
      ).toHaveLength(0);
      await tx.as(s.ben, s.acme);
      expect((await tx.one<{ text: string }>("select text from memory.memory")).text).toBe(
        "Prefers UK spelling",
      );
    });
  });
});
