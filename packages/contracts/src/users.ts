import { z } from "zod";

/** Users, roles and groups as an administrator manages them. */

export const PERMISSIONS = [
  "threads.use",
  "vaults.create",
  "tables.create",
  "agents.use",
  "agents.build",
  "agents.admin",
  "playbooks.use",
  "playbooks.create",
  "playbooks.manage",
  "spaces.use",
  "spaces.create",
  "spaces.invite",
  "spaces.external",
  "spaces.manage",
  "spaces.templates",
  "spaces.analytics",
  "spaces.connections",
  "library.manage",
  "memory.use",
  "models.select",
  "connectors.use",
  "groups.create_public",
  "intake.manage",
  "intake.triage",
  "admin.users",
  "admin.config",
  "admin.reporting",
  "admin.audit",
  "admin.retention",
  "admin.matters",
  "admin.history",
  "admin.personalisation",
  "api.service_accounts",
] as const;

export const DEFAULT_USER_PERMISSIONS = [
  "threads.use",
  "vaults.create",
  "tables.create",
  "agents.use",
  "playbooks.use",
  "spaces.use",
  "spaces.create",
  "spaces.invite",
  "memory.use",
  "connectors.use",
] as const;

/** True for a permission that makes whoever holds it an administrator of something. */
export const isAdminPermission = (p: string) =>
  p === "*" || p.startsWith("admin.") || p === "api.service_accounts";

export const MAX_INVITES = 100;
export const MAX_CUSTOM_ROLES = 5;
export const MIN_PASSWORD_LENGTH = 12;
/** How long an invitation link works. */
export const INVITE_HOURS = 72;

const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((t) => !t.includes("\0"), "Text cannot hold a NUL byte");
const groupIds = z.array(z.uuid()).max(50);

export const InviteUsers = z.strictObject({
  // Counted again by the server, which answers INVITE_LIMIT for a longer list.
  emails: z.array(z.string().max(320)).min(1).max(1000),
  role_id: z.uuid(),
  group_ids: groupIds.optional(),
});
export type InviteUsers = z.infer<typeof InviteUsers>;

export const UserPatch = z
  .strictObject({
    role_id: z.uuid().optional(),
    group_ids: groupIds.optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");
export type UserPatch = z.infer<typeof UserPatch>;

export const RoleInput = z.strictObject({
  name,
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});
export type RoleInput = z.infer<typeof RoleInput>;

export const GroupInput = z.strictObject({ name });

export const AcceptInvite = z.strictObject({
  token: z.string().min(20).max(100),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(256),
});

export type UserStatus = "invited" | "active" | "suspended" | "deprovisioned";

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role_id: string | null;
  role_name: string | null;
  group_ids: string[];
  source: "manual" | "scim";
  /** The role comes from a mapped identity provider group, so it can't be changed here. */
  role_from_group: boolean;
  is_self: boolean;
}

export interface UserDirectory {
  items: ManagedUser[];
  scim_enabled: boolean;
  sso_enabled: boolean;
  mail_configured: boolean;
}

export interface Role {
  id: string;
  name: string;
  builtin: boolean;
  permissions: string[];
  /** Whether people can be invited straight into this role. */
  admin: boolean;
}

export interface Group {
  id: string;
  name: string;
  /** False for groups an identity provider owns. */
  manageable: boolean;
}

/** `link` is present only when no mail server is set up, and is never shown again. */
export interface Invitation {
  id: string;
  email: string;
  delivery: "email" | "link" | "sso" | "failed";
  link?: string;
}

export interface InviteResult {
  invited: Invitation[];
  skipped: { email: string; reason: "exists" | "duplicate" | "invalid" }[];
}

const scope = z
  .string()
  .max(100)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, "A scope has no spaces or quotes");

/** Single sign-on through OpenID Connect. SAML reaches it through a broker. */
export const SsoInput = z.strictObject({
  issuer: z.url().max(512),
  client_id: z.string().trim().min(1).max(512),
  /** A string replaces the saved secret, null removes it, left out keeps it. */
  client_secret: z.string().min(1).max(2048).nullable().optional(),
  scopes: z.array(scope).max(20).default(["openid", "email", "profile"]),
  enabled: z.boolean(),
  /** Attach a first sign-in to the account with the same verified email. */
  link_by_email: z.boolean().default(false),
  /** Refuse a sign-in the identity provider did not strengthen with a second factor. */
  require_mfa_claim: z.boolean().default(false),
});
export type SsoInput = z.input<typeof SsoInput>;

export interface SsoSettings {
  configured: boolean;
  issuer: string;
  client_id: string;
  scopes: string[];
  enabled: boolean;
  link_by_email: boolean;
  require_mfa_claim: boolean;
  has_secret: boolean;
  /** What to register with the identity provider. */
  redirect_uri: string;
  /** False when this installation has no key to seal a secret with. */
  secret_storage: boolean;
  can_change: boolean;
}
