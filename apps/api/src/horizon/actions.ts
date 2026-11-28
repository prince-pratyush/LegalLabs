import { HORIZON_SOURCES } from "@legallabs/contracts";
import { type ItemText, SOURCES } from "@legallabs/knowledge";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { trackUsage } from "../command-center/record.js";
import { asApp } from "../db.js";
import type { Documents, UploadResult } from "../documents/documents.js";
import type { Drafts } from "../drafts/drafts.js";
import type { Threads } from "../threads/threads.js";
import type { Vaults } from "../vaults/vaults.js";
import { audit, enabled, ITEM, ITEM_FROM, type ItemRow, UUID } from "./horizon.js";

// What a reader does with something a scan found. Only the published text and its details ever
// leave the scan: never the purpose, the topics or the model's explanation, which would tell
// whoever reads the copy what the owner is watching for.

export type ActionFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "DISABLED"
  | "SOURCE_UNAVAILABLE"
  | "VAULT_NOT_FOUND"
  | "MATTER_REQUIRED"
  | "UPLOAD_REFUSED";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; reason: ActionFailure };

const refused = (reason: ActionFailure) => ({ ok: false as const, reason });

export interface HorizonActionOptions {
  documents: Documents;
  vaults: Vaults;
  threads: Threads;
  drafts: Drafts;
  /** The item's full text from its source. */
  text: ItemText;
}

type Item = ItemRow & { external_id: string };

const sourceName = (item: Item) =>
  HORIZON_SOURCES.find((s) => s.id === item.source_id)?.name ?? item.source_id;

/** A file name from the title: no separators, controls or leading dots. */
export function fileName(title: string): string {
  const name = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .slice(0, 120)
    .trim();
  return `${name || "Development"}.txt`;
}

const document = (item: Item, text: string) =>
  [
    item.development,
    `Source: ${sourceName(item)}`,
    `Published: ${item.published_at}`,
    `Address: ${item.source_url}`,
    SOURCES.find((s) => s.id === item.source_id)?.attribution ?? "",
    "",
    text,
  ].join("\n");

// An address inside published words is not one we vouch for. These are the forms a mail client
// turns into a link: any scheme with "//", "mailto:", "www." and a bare "//host".
const ADDRESS =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bmailto:|\bwww\.|(?<![\p{L}\p{N}:/])\/\/(?=[^\s/]))\S+/giu;
const noLinks = (text: string) => text.replace(ADDRESS, "[link removed]");

export function emailDraft(item: {
  development: string;
  summary: string;
  source_url: string;
  published_at: string;
  source: string;
}): string {
  return [
    `Subject: ${noLinks(item.development)}`,
    "",
    "Hello,",
    "",
    "This development may be of interest.",
    "",
    noLinks(item.development),
    `${item.source}, published ${item.published_at}`,
    item.source_url,
    ...(item.summary ? ["", noLinks(item.summary)] : []),
    "",
    "Kind regards,",
  ].join("\n");
}

type UploadFailure = Extract<UploadResult, { ok: false }>["reason"] | "NOT_FOUND";

const UPLOADS: Partial<Record<UploadFailure, ActionFailure>> = {
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "VAULT_NOT_FOUND",
  MATTER_NOT_FOUND: "FORBIDDEN",
};

export function createHorizonActions(pool: pg.Pool, options: HorizonActionOptions) {
  const { documents, vaults, threads, drafts } = options;

  /** The item, if it is the caller's and scanning is on. */
  const itemOf = (p: Principal, id: string) =>
    asApp(pool, p, async (db): Promise<ActionResult<Item>> => {
      const { rows: member } = await db.query<{ ok: boolean }>("select apps.horizon_member() ok");
      if (!member[0]?.ok) return refused("FORBIDDEN");
      if (!(await enabled(db))) return refused("DISABLED");
      if (!UUID.test(id)) return refused("NOT_FOUND");
      const { rows } = await db.query<Item>(
        `select ${ITEM}, i.external_id from ${ITEM_FROM} where i.id = $1`,
        [id],
      );
      return rows[0] ? { ok: true, value: rows[0] } : refused("NOT_FOUND");
    });

  /** The item with its text as a file ready to store. Nothing is stored without the text. */
  async function fetched(p: Principal, id: string) {
    const found = await itemOf(p, id);
    if (!found.ok) return found;
    const item = found.value;
    const text = await options.text(item.source_id, item.external_id).catch(() => null);
    if (!text) return refused("SOURCE_UNAVAILABLE");
    return {
      ok: true as const,
      value: {
        item,
        name: fileName(item.development),
        bytes: new TextEncoder().encode(document(item, text)),
      },
    };
  }

  const used = (p: Principal, kind: string, itemId: string) =>
    asApp(pool, p, (db) =>
      trackUsage(db, {
        surface: "apps",
        action: "horizon.item.action",
        actionClass: "other",
        subsurface: kind,
        objectType: "horizon_item",
        objectId: itemId,
      }),
    );

  return {
    async saveToVault(
      p: Principal,
      itemId: string,
      to: { vaultId: string; folderId: string | null },
      client: Client,
    ): Promise<ActionResult<{ document_id: string }>> {
      const file = await fetched(p, itemId);
      if (!file.ok) return file;
      const result = await vaults.upload(
        p,
        to.vaultId,
        {
          name: file.value.name,
          bytes: file.value.bytes,
          folderId: to.folderId,
          // In the upload's own transaction, so no copy is made without its record.
          within: (db, documentId) =>
            audit(
              db,
              p,
              "horizon.item.saved_to_vault",
              "document",
              documentId,
              { item_id: itemId },
              client,
            ),
        },
        client,
      );
      if (!result.ok) return refused(UPLOADS[result.reason] ?? "UPLOAD_REFUSED");
      await used(p, "save_to_vault", itemId);
      return { ok: true, value: { document_id: result.document.id } };
    },

    /** A thread of the reader's own with the item attached; they put the question themselves. */
    async ask(
      p: Principal,
      itemId: string,
      matterId: string | null,
      client: Client,
    ): Promise<ActionResult<{ thread_id: string; document_id: string }>> {
      const file = await fetched(p, itemId);
      if (!file.ok) return file;
      const allowed = await threads.canOpen(p, matterId);
      if (allowed !== "ok") return refused(allowed);
      const upload = await documents.upload(
        p,
        { name: file.value.name, bytes: file.value.bytes, matterId },
        client,
      );
      if (!upload.ok) return refused(UPLOADS[upload.reason] ?? "UPLOAD_REFUSED");
      const opened = await threads.open(
        p,
        { title: file.value.item.development, matterId, documentIds: [upload.document.id] },
        client,
      );
      if (!opened.ok) return refused(opened.reason);
      await used(p, "ask", itemId);
      return {
        ok: true,
        value: { thread_id: opened.threadId, document_id: upload.document.id },
      };
    },

    /** A thread holding an email to edit. No model is called and nothing is sent. */
    async draftEmail(
      p: Principal,
      itemId: string,
      matterId: string | null,
      client: Client,
    ): Promise<ActionResult<{ thread_id: string; draft_id: string }>> {
      const found = await itemOf(p, itemId);
      if (!found.ok) return found;
      const item = found.value;
      const opened = await threads.open(
        p,
        { title: item.development, matterId, documentIds: [] },
        client,
      );
      if (!opened.ok) return refused(opened.reason);
      const created = await drafts.create(
        p,
        opened.threadId,
        { kind: "notepad", title: `Email: ${item.development}`.slice(0, 200) },
        client,
      );
      if (!created.ok) return refused("FORBIDDEN");
      const saved = await drafts.save(
        p,
        created.draft.id,
        emailDraft({ ...item, source: sourceName(item) }),
      );
      if (!saved.ok) return refused("FORBIDDEN");
      await used(p, "draft_email", itemId);
      return { ok: true, value: { thread_id: opened.threadId, draft_id: created.draft.id } };
    },
  };
}

export type HorizonActions = ReturnType<typeof createHorizonActions>;
