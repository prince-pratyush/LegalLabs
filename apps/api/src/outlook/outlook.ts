import {
  OUTLOOK_LIMITS,
  type OutlookDraft,
  type OutlookIngest,
  type OutlookItem,
  type OutlookSaved,
} from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { track, trackUsage } from "../command-center/record.js";
import { asApp } from "../db.js";
import { mayLeaveThread } from "../documents/copy.js";
import type { Documents, Summary } from "../documents/documents.js";
import type { Threads } from "../threads/threads.js";
import type { Vaults } from "../vaults/vaults.js";
import { emailEml, emailText, fileName, neutralName, oneLine, replyHtml } from "./message.js";

export type OutlookFailure =
  | "FORBIDDEN"
  | "MATTER_NOT_FOUND"
  | "MATTER_REQUIRED"
  | "NOT_STORED"
  | "NOT_FOUND"
  | "COPY_DISABLED"
  | "TOO_LONG"
  | "VAULT_NOT_FOUND"
  | "VAULT_READ_ONLY"
  | "VAULT_FULL";

export type OutlookResult<T> = { ok: true; value: T } | { ok: false; reason: OutlookFailure };

const refused = (reason: OutlookFailure) => ({ ok: false as const, reason });

// Upload refusals that mean the caller may no longer write here.
const DENIED: ReadonlySet<string> = new Set(["FORBIDDEN", "NOT_FOUND", "MATTER_NOT_FOUND"]);

export interface Attached {
  name: string;
  bytes: Uint8Array;
}

export interface OutlookOptions {
  documents: Documents;
  threads: Threads;
  vaults: Vaults;
  /** Whether email files can be read (docproc); otherwise a saved email is kept as text. */
  eml?: boolean;
}

const encode = (text: string) => new TextEncoder().encode(text);

type Db = pg.PoolClient;

const documentOf = (found: Summary, kind: "email" | "attachment") => ({
  document_id: found.id,
  name: found.name,
  kind,
  status: found.status,
});

/** What the Outlook pane does with the open message. Nothing here sends mail or can. */
export function createOutlook(pool: pg.Pool, options: OutlookOptions) {
  const { documents, threads, vaults } = options;

  const audit = (
    db: Db,
    p: Principal,
    action: string,
    objectType: "thread" | "vault",
    objectId: string,
    details: object,
    client: Client,
  ) =>
    // Ids and counts only: nothing an email says reaches the log.
    db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
      action,
      p.userId,
      objectType,
      objectId,
      JSON.stringify(details),
      client.ip,
      uaHash(client),
    ]);

  const used = (p: Principal, action: string, objectType: string, objectId: string) =>
    track(pool, p, (db) =>
      trackUsage(db, {
        surface: "outlook",
        accessPoint: "outlook",
        action,
        actionClass: "other",
        objectType,
        objectId,
      }),
    );

  return {
    /** The open message and its attachments as documents on a new thread of the caller's. */
    async ingest(
      p: Principal,
      input: { item: OutlookItem; matterId: string | null; attachments: readonly Attached[] },
      client: Client,
    ): Promise<OutlookResult<OutlookIngest>> {
      const { item, matterId } = input;
      // Asked first, so a refusal leaves nothing behind.
      const allowed = await threads.canOpen(p, matterId);
      if (allowed === "MATTER_REQUIRED") return refused(allowed);
      if (allowed !== "ok") return refused(matterId ? "MATTER_NOT_FOUND" : "FORBIDDEN");

      const skipped: OutlookIngest["skipped"] = [];
      const stored: OutlookIngest["documents"] = [];
      const files = input.attachments.slice(0, OUTLOOK_LIMITS.attachments).map((a, i) => {
        const sent = fileName(a.name);
        return { sent, name: neutralName(sent, i), bytes: a.bytes };
      });
      const upload = (name: string, bytes: Uint8Array) =>
        documents.upload(p, { name, bytes, matterId }, client);

      // The sender's words, subject and file names included, stay inside the document's text:
      // names are listed outside the prompt's fence.
      const email = await upload(
        `Email ${item.date.slice(0, 10)}.txt`,
        encode(
          emailText(
            item,
            files.map((f) => `${f.name} (sent as ${JSON.stringify(f.sent)})`),
          ),
        ),
      );
      if (!email.ok) return refused(email.reason === "FORBIDDEN" ? "FORBIDDEN" : "NOT_STORED");
      stored.push(documentOf(email.document, "email"));

      for (const file of files) {
        const result = await upload(file.name, file.bytes);
        if (result.ok) {
          stored.push({ ...documentOf(result.document, "attachment"), sent_name: file.sent });
        } else if (result.reason === "FORBIDDEN") return refused("FORBIDDEN");
        else {
          skipped.push({
            name: file.sent,
            reason: result.reason === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "UNSUPPORTED_TYPE",
          });
        }
      }

      const opened = await threads.open(
        p,
        {
          title: oneLine(item.subject) || "Email",
          matterId,
          documentIds: stored.map((d) => d.document_id),
          surface: "outlook",
        },
        client,
      );
      if (!opened.ok) {
        return refused(opened.reason === "NOT_FOUND" ? "NOT_STORED" : opened.reason);
      }
      const attachments = stored.length - 1;
      await asApp(pool, p, (db) =>
        audit(
          db,
          p,
          "mail.items_ingested",
          "thread",
          opened.threadId,
          { count: 1, attachments, skipped: skipped.length, surface: "outlook" },
          client,
        ),
      );
      await used(p, "outlook.thread_opened", "thread", opened.threadId);
      return {
        ok: true,
        value: { thread_id: opened.threadId, documents: stored, skipped },
      };
    },

    /**
     * An answer as the body for Outlook's reply window. No draft is made here and nothing is
     * sent: the person's own Outlook opens the reply. This is where the words leave, so the
     * sources' copy controls are asked now.
     */
    async replyDraft(
      p: Principal,
      input: OutlookDraft,
      client: Client,
    ): Promise<OutlookResult<{ body_html: string }>> {
      const thread = await threads.get(p, input.thread_id);
      if (!thread?.mine || thread.surface !== "outlook") return refused("NOT_FOUND");
      const message = thread.messages.find(
        (m) => m.id === input.message_id && m.role === "assistant",
      );
      if (!message) return refused("NOT_FOUND");
      const html = replyHtml(message.content);
      if (Buffer.byteLength(html) > OUTLOOK_LIMITS.replyHtmlBytes) return refused("TOO_LONG");
      const allowed = await asApp(pool, p, async (db) => {
        if (!(await mayLeaveThread(db, thread.id))) return false;
        await audit(
          db,
          p,
          "mail.draft_prepared",
          "thread",
          thread.id,
          { message_id: message.id },
          client,
        );
        return true;
      });
      if (!allowed) return refused("COPY_DISABLED");
      await used(p, "outlook.draft_prepared", "thread", thread.id);
      return { ok: true, value: { body_html: html } };
    },

    /** The message and its attachments, filed in a folder of a vault the caller can add to. */
    async saveToVault(
      p: Principal,
      input: {
        item: OutlookItem;
        vaultId: string;
        folderId: string | null;
        attachments: readonly Attached[];
      },
      client: Client,
    ): Promise<OutlookResult<OutlookSaved>> {
      const { item, vaultId } = input;
      // Asked before anything is made, so a refusal leaves no empty folder behind.
      const may = await asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ level: string | null; allowed: boolean }>(
          `select content.vault_level(v.id) level,
                  core.has_permission('threads.use') and core.can_access_matter(v.matter_id) allowed
             from content.vault v where v.id = $1 and v.deleted_at is null`,
          [vaultId],
        );
        return rows[0];
      });
      if (!may?.level) return refused("VAULT_NOT_FOUND");
      if (!may.allowed || !["owner", "full", "edit"].includes(may.level)) {
        return refused("FORBIDDEN");
      }
      let folder: Awaited<ReturnType<Vaults["createFolder"]>>;
      try {
        folder = await vaults.createFolder(
          p,
          vaultId,
          {
            name: fileName(`${item.date.slice(0, 10)} ${fileName(item.subject, "Email")}`),
            parentId: input.folderId,
          },
          client,
        );
      } catch (err) {
        // A synced vault mirrors its source and takes nothing by hand.
        if (err instanceof Error && err.message === "VAULT_READ_ONLY") {
          return refused("VAULT_READ_ONLY");
        }
        throw err;
      }
      if (!folder.ok) {
        return refused(folder.reason === "FORBIDDEN" ? "FORBIDDEN" : "VAULT_NOT_FOUND");
      }

      const folderId = folder.value.id;
      const files: OutlookSaved["files"] = [];
      const skipped: OutlookSaved["skipped"] = [];
      const names = input.attachments.map((a) => fileName(a.name));
      const upload = (name: string, bytes: Uint8Array) =>
        vaults.upload(p, vaultId, { name, bytes, folderId }, client);
      const recordSaved = () =>
        asApp(pool, p, (db) =>
          audit(
            db,
            p,
            "mail.saved_to_vault",
            "vault",
            vaultId,
            { count: files.length, folder_id: folderId },
            client,
          ),
        );

      // The folder carries the subject; the file's name stays out of the sender's hands.
      const message = await upload(
        `Email ${item.date.slice(0, 10)}.${options.eml ? "eml" : "txt"}`,
        encode(options.eml ? emailEml(item) : emailText(item, names)),
      );
      if (!message.ok) {
        await vaults.trash(p, vaultId, { documentIds: [], folderIds: [folderId] }, client);
        if (message.reason.startsWith("VAULT_")) return refused("VAULT_FULL");
        return refused(DENIED.has(message.reason) ? "FORBIDDEN" : "NOT_STORED");
      }
      files.push({ document_id: message.document.id, name: message.document.name });

      for (const [i, attachment] of input.attachments.entries()) {
        const name = names[i] ?? "attachment";
        const result = await upload(name, attachment.bytes);
        if (result.ok) {
          files.push({ document_id: result.document.id, name: result.document.name });
        } else if (DENIED.has(result.reason)) {
          // Access went part-way through: what is in stays, and is on the record.
          await recordSaved();
          return refused("FORBIDDEN");
        } else {
          skipped.push({
            name,
            reason:
              result.reason === "UNSUPPORTED_TYPE" || result.reason === "FILE_TOO_LARGE"
                ? result.reason
                : "OVER_LIMIT",
          });
        }
      }
      await recordSaved();
      await used(p, "outlook.saved_to_vault", "vault", vaultId);
      return {
        ok: true,
        value: { folder_id: folderId, folder_name: folder.value.name, files, skipped },
      };
    },
  };
}

export type Outlook = ReturnType<typeof createOutlook>;
