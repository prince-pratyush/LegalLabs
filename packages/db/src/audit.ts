import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface AuditRow extends Record<string, unknown> {
  seq: number;
  prev_hash: string;
  hash: string;
  canonical: string;
}

export interface AuditAnchor {
  day: string;
  last_seq: number;
  last_hash: string;
}

export type VerifyResult =
  | { ok: true; events: number }
  | { ok: false; seq: number; reason: string };

export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const GENESIS = "00".repeat(32);
const FIELDS = [
  "workspace_id",
  "seq",
  "at",
  "actor_type",
  "actor_id",
  "action",
  "object_type",
  "object_id",
  "details",
  "ip",
  "ua_hash",
];

// Kept short and dependency-free so an auditor can read every line.
export function verifyAuditChain(rows: AuditRow[], anchors: AuditAnchor[] = []): VerifyResult {
  const fail = (seq: number, reason: string): VerifyResult => ({ ok: false, seq, reason });
  let prev = GENESIS;
  let expected = 1;
  for (const row of rows) {
    if (row.seq !== expected) return fail(row.seq, `event ${expected} is missing`);
    if (row.prev_hash !== prev) return fail(row.seq, "does not link to the previous event");
    const hash = createHash("sha256")
      .update(Buffer.from(prev, "hex"))
      .update(row.canonical, "utf8")
      .digest("hex");
    if (hash !== row.hash) return fail(row.seq, "hash does not match the recorded text");
    const recorded = JSON.parse(row.canonical) as Record<string, unknown>;
    for (const field of FIELDS) {
      if (!isDeepStrictEqual(recorded[field], row[field])) {
        return fail(row.seq, `${field} differs from the recorded text`);
      }
    }
    prev = row.hash;
    expected += 1;
  }
  for (const anchor of anchors) {
    if (rows[anchor.last_seq - 1]?.hash !== anchor.last_hash) {
      return fail(anchor.last_seq, `does not match the anchor for ${anchor.day}`);
    }
  }
  return { ok: true, events: rows.length };
}

export async function readAuditChain(db: Queryable, workspaceId: string): Promise<AuditRow[]> {
  const { rows } = await db.query(
    `select workspace_id, seq::float8 as seq,
            to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
            actor_type, actor_id, action, object_type, object_id, details, ip, ua_hash,
            encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash, canonical
       from admin.audit_event where workspace_id = $1 order by seq`,
    [workspaceId],
  );
  return rows as AuditRow[];
}
