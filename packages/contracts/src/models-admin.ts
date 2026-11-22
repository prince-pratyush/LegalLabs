import { z } from "zod";

/** ADM-005: what an admin sees and sets for one provider model. The key itself is never returned. */
export const ModelCapability = z.enum(["chat", "embed", "rerank"]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const TaskClassName = z.enum(["synthesize", "plan", "read_extract", "draft_edit"]);

export const ModelConfig = z.object({
  provider: z.string().min(1).max(60),
  model: z.string().min(1).max(120),
  enabled: z.boolean(),
  /** Role ids. Empty with no users means nobody is allowed. */
  enabled_for_roles: z.array(z.string().uuid()),
  enabled_for_users: z.array(z.string().uuid()),
  /** A reference such as `sec_…`; the value is encrypted and never leaves the server. */
  byok_secret_ref: z.string().nullable(),
  endpoint_url: z.string().url().nullable(),
  region: z.string().min(1).max(40),
  zdr: z.boolean(),
  capabilities: z.array(ModelCapability),
  context_window: z.number().int().positive().nullable(),
  task_class_default: z.array(TaskClassName),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ModelConfigPatch = ModelConfig.pick({
  enabled: true,
  enabled_for_roles: true,
  enabled_for_users: true,
  endpoint_url: true,
  region: true,
  zdr: true,
  task_class_default: true,
}).partial();
export type ModelConfigPatch = z.infer<typeof ModelConfigPatch>;

export const ModelKeyInput = z.object({ key: z.string().min(8).max(4096) });

export const LocalEndpointInput = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  api_key: z.string().min(1).max(4096).optional(),
  context_window: z.number().int().positive(),
  capabilities: z.array(ModelCapability).min(1),
});
export type LocalEndpointInput = z.infer<typeof LocalEndpointInput>;

export const ModelPolicy = z.object({
  zdr_only: z.boolean(),
  /** Only models in this region qualify; null means any. */
  region_only: z.string().min(1).max(40).nullable(),
  /** Roles that cannot pick a model; Auto is forced for them. */
  selector_disabled_roles: z.array(z.string().uuid()),
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

export const ModelList = z.object({ items: z.array(ModelConfig), policy: ModelPolicy });
export type ModelList = z.infer<typeof ModelList>;

export const ModelTestResult = z.object({ ok: z.boolean(), message: z.string() });

/** ADM-006 / CON-001. */
export const ToolPolicy = z.enum(["allow", "ask_user", "block"]);
export type ToolPolicy = z.infer<typeof ToolPolicy>;

export const TrustTier = z.enum(["first_party", "vendor", "community", "custom"]);
export type TrustTier = z.infer<typeof TrustTier>;

export const ConnectorStatus = z.enum(["pending_approval", "enabled", "disabled"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const ConnectorTool = z.object({
  name: z.string().min(1).max(200),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()),
  /** Workspace policy; new and undiscovered tools are `block`. */
  policy: ToolPolicy,
  /** The caller's own tightening, if any. */
  user_policy: ToolPolicy.nullable(),
});
export type ConnectorTool = z.infer<typeof ConnectorTool>;

export const Connector = z.object({
  id: z.string().uuid(),
  name: z.string(),
  url: z.string().url(),
  auth_kind: z.enum(["none", "bearer", "oauth_client"]),
  trust_tier: TrustTier,
  /** "Custom — not reviewed" for the custom tier. */
  badge: z.string(),
  status: ConnectorStatus,
  manifest_hash: z.string().nullable(),
  /** `CONNECTOR_MANIFEST_CHANGED` after drift. */
  disabled_reason: z.string().nullable(),
  tools: z.array(ConnectorTool),
  created_at: z.string(),
});
export type Connector = z.infer<typeof Connector>;

export const ConnectorInput = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().startsWith("https://"),
  auth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("bearer"), token: z.string().min(1).max(4096) }),
    z.object({
      kind: z.literal("oauth_client"),
      client_id: z.string().min(1).max(500),
      client_secret: z.string().min(1).max(4096),
    }),
  ]),
});
export type ConnectorInput = z.infer<typeof ConnectorInput>;

export const ToolPolicyInput = z.object({ policy: ToolPolicy });

/** A user may only tighten, so `allow` is not an option for them. */
export const UserToolPolicyInput = z.object({ policy: z.enum(["ask_user", "block"]) });

export const ManifestDiff = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type ManifestDiff = z.infer<typeof ManifestDiff>;

export const DiscoverResult = z.object({
  connector: Connector,
  /** Present when rediscovery found drift. */
  diff: ManifestDiff.nullable(),
});
export type DiscoverResult = z.infer<typeof DiscoverResult>;
