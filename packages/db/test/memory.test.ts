import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

const hash = (text: string) => createHash("sha256").update(text.toLowerCase()).digest("hex");

// Ben and Cal's role holds threads.use only; memory.use is granted per person here.
async function allow(tx: Tx, ...users: string[]) {
  await tx.asOwner();
  await tx.rows(
    `update core."user" set extra_permissions = array['memory.use']
      where id = any ($1::uuid[])`,
    [users],
  );
}

async function remember(tx: Tx, s: Seed, user: string, text: string, source = "manual") {
  await tx.as(user, s.acme);
  return (
    await tx.one<{ id: string }>(
      `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
       values ($1, $2, $3, $4, $5) returning id`,
      [s.acme, user, text, source, hash(text)],
    )
  ).id;
}

const count = async (tx: Tx, user: string, ws: string, table: string) => {
  await tx.as(user, ws);
  return Number((await tx.one<{ n: string }>(`select count(*) n from memory.${table}`)).n);
};

describe("memory", () => {
  it("is invisible to an admin: the '*' role user sees none of another user's rows", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      const id = await remember(tx, s, s.ben, "Use UK spelling");
      await tx.as(s.ben, s.acme);
      await tx.rows("insert into memory.memory_setting (workspace_id, user_id) values ($1, $2)", [
        s.acme,
        s.ben,
      ]);
      await tx.rows(
        "insert into memory.memory_candidate (workspace_id, user_id, text) values ($1, $2, 'Be formal')",
        [s.acme, s.ben],
      );
      await tx.rows(
        "insert into memory.memory_import (workspace_id, user_id, rows) values ($1, $2, '[]')",
        [s.acme, s.ben],
      );

      for (const table of ["memory", "memory_setting", "memory_candidate", "memory_import"]) {
        expect(await count(tx, s.ben, s.acme, table)).toBe(1);
        // Ana holds "*", dee holds admin.users, bob is another workspace's admin.
        expect(await count(tx, s.ana, s.acme, table)).toBe(0);
        expect(await count(tx, s.dee, s.acme, table)).toBe(0);
        // Bob sees only the one row the fixture gave him in his own workspace.
        expect(await count(tx, s.bob, s.beta, table)).toBe(1);
      }
      await tx.as(s.ana, s.acme);
      // Nor can she reach it by id, change it or delete it.
      expect(await tx.rows("select id from memory.memory where id = $1", [id])).toEqual([]);
      expect(
        await tx.rows("update memory.memory set text = 'x' where id = $1 returning id", [id]),
      ).toEqual([]);
      expect(await tx.rows("delete from memory.memory where id = $1 returning id", [id])).toEqual(
        [],
      );
      expect(await count(tx, s.ben, s.acme, "memory")).toBe(1);
    });
  });

  it("is hidden without memory.use, and returns with it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      await remember(tx, s, s.ben, "Cite pin points");
      await tx.asOwner();
      await tx.rows(`update core."user" set extra_permissions = '{}' where id = $1`, [s.ben]);
      expect(await count(tx, s.ben, s.acme, "memory")).toBe(0);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
           values ($1, $2, 'x', 'manual', $3)`,
          [s.acme, s.ben, hash("x")],
        ),
      ).toMatch(/row-level security/);
      await allow(tx, s.ben);
      expect(await count(tx, s.ben, s.acme, "memory")).toBe(1);
    });
  });

  it("is not available to guests or suspended users, or written for someone else", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben, s.cal);
      await tx.as(s.gia, s.acme);
      expect(
        await tx.error(
          `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
           values ($1, $2, 'x', 'manual', $3)`,
          [s.acme, s.gia, hash("x")],
        ),
      ).toMatch(/row-level security/);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
           values ($1, $2, 'x', 'manual', $3)`,
          [s.acme, s.cal, hash("x")],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("keeps each user's memories apart and allows the same text for two people", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben, s.cal);
      const mine = await remember(tx, s, s.ben, "Use UK spelling");
      await remember(tx, s, s.cal, "Use UK spelling");
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select id from memory.memory where id = $1", [mine])).toEqual([]);
      expect(await count(tx, s.cal, s.acme, "memory")).toBe(1);
    });
  });

  it("holds a text once per user (unique normalised hash)", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      await remember(tx, s, s.ben, "Use UK spelling");
      expect(
        await tx.error(
          `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
           values ($1, $2, 'use uk spelling', 'asked', $3)`,
          [s.acme, s.ben, hash("Use UK spelling")],
        ),
      ).toMatch(/unique/);
    });
  });

  it("holds text to 1,000 characters, trimmed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      await tx.as(s.ben, s.acme);
      const insert = (text: string) =>
        tx.error(
          `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
           values ($1, $2, $3, 'manual', $4)`,
          [s.acme, s.ben, text, hash(text)],
        );
      expect(await insert("x".repeat(1000))).toBeUndefined();
      expect(await insert("y".repeat(1001))).toMatch(/check/);
      expect(await insert(" padded ")).toMatch(/check/);
      expect(await insert("")).toMatch(/check/);
    });
  });

  it("stops at 1,000 memories a user", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
         select $1, $2, 'm' || n, 'imported', encode(sha256(convert_to('m' || n, 'utf8')), 'hex')
           from generate_series(1, 1000) n`,
        [s.acme, s.ben],
      );
      expect(
        await tx.error(
          `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
           values ($1, $2, 'one more', 'manual', $3)`,
          [s.acme, s.ben, hash("one more")],
        ),
      ).toMatch(/LIMIT_MEMORIES/);
    });
  });

  it("lets only the owner edit the words, and not the owner or source", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      const id = await remember(tx, s, s.ben, "Use UK spelling");
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("update memory.memory set text = 'Use US spelling' where id = $1", [id]),
      ).toBeUndefined();
      expect(
        await tx.error("update memory.memory set user_id = $2 where id = $1", [id, s.cal]),
      ).toMatch(/permission denied/);
      expect(
        await tx.error("update memory.memory set source = 'asked' where id = $1", [id]),
      ).toMatch(/permission denied/);
    });
  });

  it("deletes with the user account", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      await remember(tx, s, s.ben, "Use UK spelling");
      await tx.asOwner();
      await tx.rows(`delete from core."user" where id = $1`, [s.ben]);
      const { n } = await tx.one<{ n: string }>(
        "select count(*) n from memory.memory where user_id = $1",
        [s.ben],
      );
      expect(Number(n)).toBe(0);
    });
  });
});

describe("memory purge", () => {
  it("drops candidates after 30 days and old imports, and only the worker may run it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await allow(tx, s.ben);
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into memory.memory_candidate (workspace_id, user_id, text) values ($1, $2, 'Be formal')`,
        [s.acme, s.ben],
      );
      await tx.rows(
        "insert into memory.memory_import (workspace_id, user_id, rows) values ($1, $2, '[]')",
        [s.acme, s.ben],
      );
      expect(await tx.error("select * from memory.purge()")).toMatch(/permission denied/);

      await tx.asWorker();
      expect(await tx.rows("select * from memory.purge(now() + interval '29 days')")).toEqual([
        // Ben's upload and the fixture's, in the other workspace.
        { candidates: 0, imports: 2 },
      ]);
      expect(await tx.rows("select * from memory.purge(now() + interval '31 days')")).toEqual([
        { candidates: 2, imports: 0 },
      ]);
    });
  });
});

describe("message use", () => {
  it("is the author's alone", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      const thread = (
        await tx.one<{ id: string }>(
          `insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 't') returning id`,
          [s.acme, s.ben],
        )
      ).id;
      const message = (
        await tx.one<{ id: string }>(
          `insert into work.message (workspace_id, thread_id, role, content)
           values ($1, $2, 'assistant', 'hello') returning id`,
          [s.acme, thread],
        )
      ).id;
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into memory.message_use (message_id, workspace_id, user_id, memory_ids)
         values ($1, $2, $3, array[core.uuid7()])`,
        [message, s.acme, s.ben],
      );
      expect(await count(tx, s.ben, s.acme, "message_use")).toBe(1);
      expect(await count(tx, s.ana, s.acme, "message_use")).toBe(0);
      expect(await count(tx, s.cal, s.acme, "message_use")).toBe(0);
      // Recorded for the asker only.
      await tx.as(s.cal, s.acme);
      expect(
        await tx.error(
          `insert into memory.message_use (message_id, workspace_id, user_id) values ($1, $2, $3)`,
          [message, s.acme, s.ben],
        ),
      ).toMatch(/row-level security/);
    });
  });
});

async function style(tx: Tx, s: Seed, owner: string, name = "Terse") {
  await tx.as(owner, s.acme);
  return (
    await tx.one<{ id: string }>(
      `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
       values ($1, $2, $3, 'instructions', 'Short sentences.') returning id`,
      [s.acme, owner, name],
    )
  ).id;
}

const sees = async (tx: Tx, user: string, ws: string, id: string) => {
  await tx.as(user, ws);
  return (await tx.rows("select id from memory.writing_style where id = $1", [id])).length === 1;
};

describe("writing styles", () => {
  it("are private to their owner until shared, and never cross workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await style(tx, s, s.ben);
      expect(await sees(tx, s.ben, s.acme, id)).toBe(true);
      expect(await sees(tx, s.cal, s.acme, id)).toBe(false);
      // Not even an admin reads a private style.
      expect(await sees(tx, s.ana, s.acme, id)).toBe(false);
      expect(await sees(tx, s.bob, s.beta, id)).toBe(false);
    });
  });

  it("are shared read-only within the workspace, by someone holding writing_styles.share", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await style(tx, s, s.ana);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update memory.writing_style set shared = true where id = $1", [id]),
      ).toBeUndefined();

      expect(await sees(tx, s.cal, s.acme, id)).toBe(true);
      expect(await sees(tx, s.gia, s.acme, id)).toBe(false);
      expect(await sees(tx, s.bob, s.beta, id)).toBe(false);
      // Read-only for others: nothing updated or deleted.
      await tx.as(s.cal, s.acme);
      expect(
        await tx.rows("update memory.writing_style set name = 'mine' where id = $1 returning id", [
          id,
        ]),
      ).toEqual([]);
      expect(
        await tx.rows("delete from memory.writing_style where id = $1 returning id", [id]),
      ).toEqual([]);
    });
  });

  it("cannot be shared without the permission", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await style(tx, s, s.ben);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("update memory.writing_style set shared = true where id = $1", [id]),
      ).toMatch(/row-level security/);
      expect(
        await tx.error(
          `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions, shared)
           values ($1, $2, 'Open', 'instructions', 'x', true)`,
          [s.acme, s.ben],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("can be unshared or deleted by an admin, and by their owner", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows(
        `update core."user" set extra_permissions = array['writing_styles.share'] where id = $1`,
        [s.ben],
      );
      const id = await style(tx, s, s.ben);
      await tx.as(s.ben, s.acme);
      await tx.rows("update memory.writing_style set shared = true where id = $1", [id]);
      await tx.as(s.ana, s.acme);
      // No RETURNING: once unshared the row is private again, and not the admin's to read.
      expect(await tx.error("select memory.unshare_style($1)", [id])).toBeUndefined();
      expect(await sees(tx, s.ana, s.acme, id)).toBe(false);
      expect(await sees(tx, s.ben, s.acme, id)).toBe(true);
      await tx.as(s.ben, s.acme);
      await tx.rows("update memory.writing_style set shared = true where id = $1", [id]);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.rows("delete from memory.writing_style where id = $1 returning id", [id]),
      ).toHaveLength(1);
    });
  });

  it("are only unshared by a holder of the share permission", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = await style(tx, s, s.ana);
      await tx.as(s.ana, s.acme);
      await tx.rows("update memory.writing_style set shared = true where id = $1", [id]);
      await tx.as(s.cal, s.acme);
      expect(await tx.error("select memory.unshare_style($1)", [id])).toMatch(
        /insufficient_privilege|FORBIDDEN/,
      );
      await tx.as(s.bob, s.beta);
      expect(await tx.error("select memory.unshare_style($1)", [id])).toBeUndefined();
      expect(await sees(tx, s.cal, s.acme, id)).toBe(true);
    });
  });

  it("have a name unique per owner and at most 50 a user", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await style(tx, s, s.ben, "Terse");
      expect(
        await tx.error(
          `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
         values ($1, $2, 'Terse', 'instructions', 'x')`,
          [s.acme, s.ben],
        ),
      ).toMatch(/unique/);
      // Another person may reuse the name.
      await style(tx, s, s.cal, "Terse");
      await tx.as(s.ben, s.acme);
      await tx.rows(
        `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
         select $1, $2, 'S' || n, 'instructions', 'x' from generate_series(1, 49) n`,
        [s.acme, s.ben],
      );
      expect(
        await tx.error(
          `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
         values ($1, $2, 'one too many', 'instructions', 'x')`,
          [s.acme, s.ben],
        ),
      ).toMatch(/LIMIT_STYLES/);
    });
  });

  it("are not made by guests, or for someone else", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      expect(
        await tx.error(
          `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
         values ($1, $2, 'G', 'instructions', 'x')`,
          [s.acme, s.gia],
        ),
      ).toMatch(/row-level security/);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
         values ($1, $2, 'G', 'instructions', 'x')`,
          [s.acme, s.cal],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("keep their sample within 20 pages and 50,000 characters", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const sample = (pages: number, chars: number) =>
        tx.error(
          `insert into memory.writing_style (workspace_id, owner_id, name, kind, sample_text, sample_pages, sample_chars)
           values ($1, $2, $3, 'sample', 'text', $4, $5)`,
          [s.acme, s.ben, `n${pages}-${chars}`, pages, chars],
        );
      expect(await sample(20, 50000)).toBeUndefined();
      expect(await sample(21, 10)).toMatch(/check/);
      expect(await sample(1, 50001)).toMatch(/check/);
    });
  });
});
