import type { TemplatePort } from "@legallabs/contracts";
import type pg from "pg";
import { asApp } from "../db.js";

/** Finds the template a draft is exported through; row-level security decides who may use it. */
export function createTemplatePort(pool: pg.Pool): TemplatePort {
  return {
    async resolve(caller, choice) {
      if (choice === "none") return null;
      const identity = { userId: caller.userId, workspaceId: caller.workspaceId };
      return asApp(pool, identity, async (db) => {
        const { rows } = await db.query<{
          template_id: string;
          version_id: string;
          no: number;
          name: string;
          bytes: Buffer;
        }>(
          `select t.id as template_id, v.id as version_id, v.no, t.name, v.bytes
             from library.template t
             join lateral (select * from library.template_version tv where tv.template_id = t.id
                            order by tv.no desc limit 1) v on true
            where ${choice === "default" ? "t.is_default" : "t.id = $1"}`,
          choice === "default" ? [] : [choice],
        );
        const row = rows[0];
        return row
          ? {
              templateId: row.template_id,
              versionId: row.version_id,
              versionNo: row.no,
              name: row.name,
              bytes: new Uint8Array(row.bytes),
            }
          : null;
      });
    },
  };
}

/** For harnesses without a database: no firm templates. */
export const noTemplates: TemplatePort = { resolve: async () => null };
