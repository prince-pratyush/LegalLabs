import { z } from "zod";

const family = (prefix: string, names: string[]) => names.map((name) => `${prefix}.${name}`);

const objects = [
  "thread",
  "vault",
  "folder",
  "document",
  "table",
  "column",
  "cell",
  "agent",
  "workflow",
  "playbook",
  "space",
  "task",
  "scan",
  "library_item",
  "template",
  "memory",
];
const objectVerbs = [
  "created",
  "updated",
  "deleted",
  "restored",
  "moved",
  "exported",
  "version_added",
];

// Names are permanent once rows exist: add new ones, never rename.
export const auditActions: string[] = [
  "logout",
  ...family("login", ["success", "failure", "mfa_challenge"]),
  ...family("session", ["revoked", "rotated"]),
  ...family("token", ["created", "rotated", "revoked", "used_denied"]),
  ...family("guest", ["code_sent", "code_failed"]),
  ...family("scim", [
    "user_created",
    "user_updated",
    "user_deactivated",
    "group_synced",
    "mass_delete_paused",
  ]),

  ...family("role", ["created", "updated", "deleted"]),
  ...family("permission", ["granted", "revoked"]),
  "settings.changed",
  ...family("model", ["enabled", "disabled", "zdr_exception"]),
  ...family("connector", ["registered", "schema_drift", "repinned", "disabled"]),
  "retention.policy_changed",
  ...family("legal_hold", ["placed", "released"]),
  "ip_allowlist.changed",
  "branding.changed",
  "telemetry.toggled",

  ...objects.flatMap((object) => family(object, objectVerbs)),
  ...family("document", [
    "uploaded",
    "ingest_failed",
    "ingest_retried",
    "scanned_clean",
    "quarantined",
    "released",
    "password_supplied",
    "downloaded",
    "previewed",
  ]),

  ...family("share", [
    "granted",
    "changed",
    "revoked",
    "link_created",
    "link_disabled",
    "external_confirmed",
  ]),
  ...family("space", ["member_added", "member_removed", "party_level_changed", "external_access"]),
  ...family("approval", ["requested", "accepted", "denied"]),

  ...family("matter", [
    "created",
    "updated",
    "imported",
    "notice_acknowledged",
    "required_missing",
  ]),
  ...family("wall", [
    "created",
    "removed",
    "sync_applied",
    "sync_paused",
    "sync_confirmed",
    "provider_stale",
    "denied",
    "share_blocked",
  ]),

  ...family("model", ["call", "fallback", "refused_no_zdr", "region_mismatch"]),

  ...family("run", [
    "started",
    "paused",
    "resumed",
    "completed",
    "failed",
    "cancelled",
    "plan_approved",
  ]),
  ...family("tool", ["call", "approval_requested", "approval_granted", "approval_denied"]),
  "policy.fail_closed",
  "security.canary_tripped",
  "injection.withheld",

  "retention.sweep",
  ...family("deletion", ["scheduled", "completed", "verified"]),
  "recycle.restored",
  "backup.completed",
  ...family("restore", ["started", "completed"]),

  ...family("export", ["user", "matter", "legal_hold", "audit", "analytics", "evidence_pack"]),

  ...family("knowledge.filter_preset", ["created", "updated", "deleted"]),
];

export const AuditAction = z.enum(auditActions);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditActorType = z.enum(["user", "service", "system", "agent"]);
export type AuditActorType = z.infer<typeof AuditActorType>;
