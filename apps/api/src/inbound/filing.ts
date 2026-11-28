import { detectType, type Scanner, ScannerRefused, ScannerUnavailable } from "@legallabs/ingest";
import { type Documents, MAX_FILE_BYTES } from "../documents/documents.js";

// Files what came from outside in the Inbox, as the intake service user, through the same
// upload, scan and ingest path as any file.

/** Something outside the message's control is not ready: wait, without using up an attempt. */
export class NotYet extends Error {
  constructor(
    readonly why: string,
    readonly seconds: number,
  ) {
    super(why);
  }
}

/** The queued message a file belongs to. */
export interface Filed {
  id: string;
  workspace_id: string;
  service_user_id: string;
  vault_id: string;
}

export function inboxFiling(documents: Pick<Documents, "upload">, scanner: Scanner) {
  return {
    /** Why a file isn't kept, or null to keep it. */
    async unwanted(file: { name: string; bytes: Uint8Array }): Promise<string | null> {
      if (file.bytes.length === 0) return "empty";
      if (file.bytes.length > MAX_FILE_BYTES) return "too large";
      try {
        if (!(await scanner.scan(file.bytes)).clean) return "failed the malware scan";
      } catch (err) {
        if (err instanceof ScannerRefused) return "too large to scan";
        if (err instanceof ScannerUnavailable) throw new NotYet("scanner_unavailable", 300);
        throw err;
      }
      return detectType(file.bytes, file.name) ? null : "not a type that can be read";
    },

    /** Stores one part of a message; part 0 is the message's own file. */
    async file(job: Filed, partNo: number, name: string, bytes: Uint8Array) {
      const principal = {
        sessionId: "intake",
        userId: job.service_user_id,
        workspaceId: job.workspace_id,
      };
      const stored = await documents.upload(
        principal,
        {
          name,
          bytes,
          matterId: null,
          vaultId: job.vault_id,
          keepName: true,
          within: (db, documentId) =>
            db.query(
              `insert into apps.intake_attachment
                 (workspace_id, document_id, inbound_email_id, part_no)
               values ($1, $2, $3, $4)`,
              [job.workspace_id, documentId, job.id, partNo],
            ),
        },
        { ip: null, userAgent: null },
      );
      if (stored.ok) return null;
      if (stored.reason === "UNSUPPORTED_TYPE") return "not a type that can be read";
      if (stored.reason === "FILE_TOO_LARGE") return "too large";
      // A full Inbox, say: the message waits for room rather than losing a file.
      throw new NotYet(stored.reason, 3600);
    },
  };
}
