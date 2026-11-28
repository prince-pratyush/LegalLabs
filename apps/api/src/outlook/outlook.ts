import { OUTLOOK_LIMITS, type OutlookIngest, type OutlookItem } from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { track, trackUsage } from "../command-center/record.js";
import { asApp } from "../db.js";
import type { Documents, Summary } from "../documents/documents.js";
import type { Threads } from "../threads/threads.js";
import type { Vaults } from "../vaults/vaults.js";
import { emailText, fileName, oneLine } from "./message.js";

export type OutlookFailure = "FORBIDDEN" | "MATTER_NOT_FOUND" | "MATTER_REQUIRED" | "NOT_STORED";

export type OutlookResult<T> = { ok: true; value: T } | { ok: false; reason: OutlookFailure };

const refused = (reason: OutlookFailure) => ({ ok: false as const, reason });

export interface Attached {
  name: string;
  bytes: Uint8Array;
}

export interface OutlookOptions {
  documents: Documents;
  threads: Threads;
  vaults: Vaults;
}

const encode = (text: string) => new TextEncoder().encode(text);

const documentOf = (found: Summary, kind: "email" | "attachment") => ({
  document_id: found.id,
  name: found.name,
  kind,
  status: found.status,
});

/** What the Outlook pane does with the open message. Nothing here sends mail or can. */
export function createOutlook(pool: pg.Pool, options: OutlookOptions) {
  const { documents, threads } = options;

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
      const files = input.attachments
        .slice(0, OUTLOOK_LIMITS.attachments)
        .map((a) => ({ name: fileName(a.name), bytes: a.bytes }));
      const upload = (name: string, bytes: Uint8Array) =>
        documents.upload(p, { name, bytes, matterId }, client);

      // The subject stays inside the document: a name is listed outside the prompt's fence.
      const email = await upload(
        `Email ${item.date.slice(0, 10)}.txt`,
        encode(
          emailText(
            item,
            files.map((f) => f.name),
          ),
        ),
      );
      if (!email.ok) return refused(email.reason === "FORBIDDEN" ? "FORBIDDEN" : "NOT_STORED");
      stored.push(documentOf(email.document, "email"));

      for (const file of files) {
        const result = await upload(file.name, file.bytes);
        if (result.ok) stored.push(documentOf(result.document, "attachment"));
        else if (result.reason === "FORBIDDEN") return refused("FORBIDDEN");
        else {
          skipped.push({
            name: file.name,
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
        db.query(
          "select admin.append_audit_event('mail.items_ingested', 'user', $1, 'thread', $2, $3, $4, $5)",
          [
            p.userId,
            opened.threadId,
            JSON.stringify({
              count: 1,
              attachments,
              skipped: skipped.length,
              surface: "outlook",
            }),
            client.ip,
            uaHash(client),
          ],
        ),
      );
      await track(pool, p, (db) =>
        trackUsage(db, {
          surface: "outlook",
          accessPoint: "outlook",
          action: "outlook.thread_opened",
          actionClass: "other",
          objectType: "thread",
          objectId: opened.threadId,
          documentCount: stored.length,
        }),
      );
      return {
        ok: true,
        value: { thread_id: opened.threadId, documents: stored, skipped },
      };
    },
  };
}

export type Outlook = ReturnType<typeof createOutlook>;
