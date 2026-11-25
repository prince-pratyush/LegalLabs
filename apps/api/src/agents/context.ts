import type { FileKind } from "@legallabs/contracts";
import type pg from "pg";
import type { Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { AttachmentPort } from "./ports.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Material {
  name: string;
  text: string;
  documents: number;
  pages: number;
}

export interface ContextDocument {
  documentId: string;
  versionId: string;
  versionNo: number;
  name: string;
  pages: { page: number; text: string }[];
}

type Who = { userId: string; workspaceId: string };

/** Reads what an agent was given, as the person running it, so walls and shares apply. */
export interface ContextPort extends AttachmentPort {
  read(
    who: { userId: string; workspaceId: string },
    attachment: { kind: FileKind; ref: string; name: string },
    maxChars: number,
  ): Promise<Material | null>;
  /**
   * An upload, vault or folder attachment page by page, so what is quoted can be checked. With a
   * matter, documents belonging to a different matter are left out. Null for other kinds.
   */
  documents(
    who: Who,
    attachment: { kind: FileKind; ref: string },
    matterId: string | null,
  ): Promise<{ documents: ContextDocument[]; otherMatter: number } | null>;
}

const principalOf = (who: { userId: string; workspaceId: string }): Principal => ({
  sessionId: "run",
  ...who,
});

export function createContextPort(pool: pg.Pool): ContextPort {
  const as = <T>(
    who: { userId: string; workspaceId: string },
    work: (db: pg.PoolClient) => Promise<T>,
  ) => asApp(pool, principalOf(who), work);

  async function exists(who: Principal, kind: FileKind, ref: string): Promise<boolean> {
    if (!UUID.test(ref)) return false;
    return asApp(pool, who, async (db) => {
      const q = (sql: string) => db.query(sql, [ref]).then((r) => r.rows.length > 0);
      switch (kind) {
        case "upload":
          return q("select 1 from content.document where id = $1 and deleted_at is null");
        case "vault":
          return q("select 1 from content.vault where id = $1");
        case "vault_folder":
          return q("select 1 from content.folder where id = $1");
        case "review_table":
          return q("select 1 from work.review_table where id = $1");
        case "playbook":
          return q("select 1 from work.playbook where id = $1 and deleted_at is null");
        case "template_file":
          return q("select 1 from library.template where id = $1");
        default:
          // Connector files can't be read here yet, so they are never counted as available.
          return false;
      }
    });
  }

  return {
    available: (who, att) => exists(who, att.kind, att.ref),

    async documents(who, att, matterId) {
      const column = { upload: "d.id", vault: "d.vault_id", vault_folder: "d.folder_id" } as const;
      if (att.kind !== "upload" && att.kind !== "vault" && att.kind !== "vault_folder") return null;
      if (!UUID.test(att.ref)) return { documents: [], otherMatter: 0 };
      return as(who, async (db) => {
        const { rows } = await db.query<{
          document_id: string;
          version_id: string;
          version_no: number;
          name: string;
          in_matter: boolean;
          pages: { page: number; text: string }[];
        }>(
          `select d.id as document_id, latest.id as version_id, latest.version_no, d.name,
                  ($2::uuid is null
                    or (coalesce(d.matter_id, $2) = $2 and coalesce(va.matter_id, $2) = $2))
                    as in_matter,
                  coalesce((select json_agg(json_build_object('page', p.page_no, 'text', p.text)
                                            order by p.page_no)
                              from content.page p where p.version_id = latest.id), '[]') as pages
             from content.document d
             left join content.vault va on va.id = d.vault_id
             join lateral (select id, version_no from content.document_version v
                            where v.document_id = d.id order by version_no desc limit 1) latest on true
            where ${column[att.kind as keyof typeof column]} = $1 and d.deleted_at is null
            order by d.name, d.id
            limit 25`,
          [att.ref, matterId],
        );
        return {
          documents: rows
            .filter((r) => r.in_matter)
            .map((r) => ({
              documentId: r.document_id,
              versionId: r.version_id,
              versionNo: r.version_no,
              name: r.name,
              pages: r.pages,
            })),
          otherMatter: rows.filter((r) => !r.in_matter).length,
        };
      });
    },

    async read(who, att, maxChars) {
      if (!UUID.test(att.ref)) return null;
      return as(who, async (db) => {
        if (att.kind === "playbook") {
          const { rows } = await db.query<{
            name: string;
            rules: { title: string; standard_position?: string }[];
          }>(
            `select p.name, v.rules from work.playbook p join work.playbook_version v on v.id = p.version_id
              where p.id = $1 and p.deleted_at is null`,
            [att.ref],
          );
          const p = rows[0];
          if (!p) return null;
          const text = p.rules
            .map((r) => `- ${r.title}: ${r.standard_position ?? ""}`)
            .join("\n")
            .slice(0, maxChars);
          return { name: p.name, text, documents: 1, pages: 1 };
        }
        if (
          att.kind === "review_table" ||
          att.kind === "template_file" ||
          att.kind === "dms_file"
        ) {
          return { name: att.name, text: "", documents: 0, pages: 0 };
        }
        // Documents: an upload, a vault, or one folder of a vault.
        const where =
          att.kind === "upload"
            ? "d.id = $1"
            : att.kind === "vault"
              ? "d.vault_id = $1"
              : "d.folder_id = $1";
        const { rows } = await db.query<{ name: string; text: string; pages: number }>(
          `select d.name,
                  string_agg(p.text, E'\\n' order by p.page_no) as text,
                  count(p.page_no)::int as pages
             from content.document d
             join lateral (select id from content.document_version v
                            where v.document_id = d.id order by version_no desc limit 1) latest on true
             join content.page p on p.version_id = latest.id
            where ${where} and d.deleted_at is null
            group by d.id, d.name
            order by d.name
            limit 25`,
          [att.ref],
        );
        if (rows.length === 0)
          return att.kind === "upload"
            ? null
            : { name: att.name, text: "", documents: 0, pages: 0 };
        let used = 0;
        const parts: string[] = [];
        for (const r of rows) {
          const remaining = maxChars - used;
          if (remaining <= 0) break;
          const chunk = `# ${r.name}\n${r.text}`.slice(0, remaining);
          parts.push(chunk);
          used += chunk.length;
        }
        return {
          name: att.name,
          text: parts.join("\n\n"),
          documents: rows.length,
          pages: rows.reduce((n, r) => n + r.pages, 0),
        };
      });
    },
  };
}
