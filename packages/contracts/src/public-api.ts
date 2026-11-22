import { z } from "zod";

/** Scopes a public token can carry. `whoami` needs none: every valid token may ask who it is. */
export const API_SCOPES = ["audit:read", "history:read", "vaults:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const ApiScopeSchema = z.enum(API_SCOPES);

export const TOKEN_PREFIX = "cns_";
export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
export const RATE_LIMIT_PER_MINUTE = 600;
export const AUDIT_MAX_RANGE_DAYS = 7;
export const AUDIT_EXPORT_MAX = 20_000;
export const AUDIT_PAGE_MAX = 1000;

const Time = z.string().describe("ISO 8601 timestamp");
const Id = z.uuid();

export const ErrorBody = z.object({ code: z.string(), message: z.string() });

export const Whoami = z.object({
  principal_id: Id,
  kind: z.enum(["user", "service"]),
  workspace_id: Id,
  scopes: z.array(ApiScopeSchema),
  expires_at: Time.nullable(),
});

export const AuditEvent = z.object({
  seq: z.number().int(),
  at: Time,
  actor_type: z.enum(["user", "service", "system", "agent"]),
  actor_id: Id.nullable(),
  action: z.string(),
  object_type: z.string().nullable(),
  object_id: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
});
export const AuditEventsQuery = z.object({
  "filter[action]": z.string().max(100).optional(),
  "filter[actor_id]": Id.optional(),
  "filter[object_type]": z.string().max(100).optional(),
  "filter[object_id]": z.string().max(256).optional(),
  from: Time.optional().describe("Start of the range; defaults to seven days before `to`"),
  to: Time.optional().describe("End of the range; defaults to now. At most 7 days after `from`"),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(100),
});
export const AuditEventsPage = z.object({
  events: z.array(AuditEvent),
  next_cursor: z.string().nullable(),
});

export const QueryHistoryItem = z.object({
  id: Id,
  at: Time,
  user_id: Id.nullable(),
  access_point: z.string(),
  surface: z.string(),
  action: z.string(),
  model: z.string().nullable(),
  document_count: z.number().int(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
});
export const QueryHistoryQuery = z.object({
  from: Time.optional(),
  to: Time.optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const QueryHistoryPage = z.object({
  queries: z.array(QueryHistoryItem),
  next_cursor: z.string().nullable(),
});

export const VaultSummary = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  matter_id: Id.nullable(),
  files: z.number().int(),
  created_at: Time,
  updated_at: Time,
});
export const VaultList = z.object({ vaults: z.array(VaultSummary) });
export const VaultFileSummary = z.object({
  id: Id,
  folder_id: Id.nullable(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  state: z.string(),
  updated_at: Time,
});
export const VaultFolderSummary = z.object({
  id: Id,
  name: z.string(),
  parent_id: Id.nullable(),
});
export const VaultTreeQuery = z.object({
  folder_id: Id.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const VaultTree = z.object({
  folders: z.array(VaultFolderSummary),
  files: z.array(VaultFileSummary),
  next_cursor: z.string().nullable(),
});

// Admin side: who may issue tokens. These use a signed-in session, never a token.
export const ServiceAccountBody = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{1,38}$/, "lowercase letters, digits, - and _")
    .describe("Slug; the account is named svc_<name>"),
});
export const ServiceAccount = z.object({
  id: Id,
  name: z.string(),
  created_at: Time,
  tokens: z.array(
    z.object({
      id: Id,
      name: z.string(),
      scopes: z.array(z.string()),
      cidrs: z.array(z.string()),
      expires_at: Time,
      last_used_at: Time.nullable(),
      revoked_at: Time.nullable(),
    }),
  ),
});
export const ServiceAccountList = z.object({ service_accounts: z.array(ServiceAccount) });
export const TokenBody = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(ApiScopeSchema).min(1).max(API_SCOPES.length),
  expires_in_days: z.number().int().min(1).default(TOKEN_DEFAULT_DAYS),
  cidrs: z.array(z.string().max(50)).max(50).optional(),
});
export const IssuedToken = z.object({
  token_id: Id,
  token: z.string().describe("Shown once; only a hash is kept"),
  expires_at: Time,
});

export type OperationScope = ApiScope | "any_token" | "session";
export interface Operation {
  id: string;
  method: "get" | "post" | "delete";
  /** OpenAPI path template, relative to /api/v1. */
  path: string;
  summary: string;
  tag: string;
  /** `session`: signed-in admins only, a token is refused. `any_token`: every valid token. */
  scope: OperationScope;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** 200 body (or the success status given in `status`). */
  response?: z.ZodType;
  status?: 200 | 201 | 204;
  /** A non-JSON success body. */
  contentType?: string;
  params?: string[];
}

export const operations: Operation[] = [
  {
    id: "whoami",
    method: "get",
    path: "/whoami",
    summary: "Who this token is",
    tag: "Identity",
    scope: "any_token",
    response: Whoami,
  },
  {
    id: "listAuditEvents",
    method: "get",
    path: "/audit/events",
    summary: "List audit events, newest first",
    tag: "Audit",
    scope: "audit:read",
    query: AuditEventsQuery,
    response: AuditEventsPage,
  },
  {
    id: "exportAuditEvents",
    method: "get",
    path: "/audit/events/export.csv",
    summary: "Export audit events as CSV (at most 20,000 rows)",
    tag: "Audit",
    scope: "audit:read",
    query: AuditEventsQuery.omit({ cursor: true, limit: true }),
    contentType: "text/csv",
  },
  {
    id: "listQueryHistory",
    method: "get",
    path: "/history/queries",
    summary: "List queries asked in the workspace (ids and counts, never the text)",
    tag: "History",
    scope: "history:read",
    query: QueryHistoryQuery,
    response: QueryHistoryPage,
  },
  {
    id: "listVaults",
    method: "get",
    path: "/vaults",
    summary: "List the vaults this account can read",
    tag: "Vaults",
    scope: "vaults:read",
    response: VaultList,
  },
  {
    id: "getVault",
    method: "get",
    path: "/vaults/{id}",
    summary: "Get one vault",
    tag: "Vaults",
    scope: "vaults:read",
    params: ["id"],
    response: z.object({ vault: VaultSummary }),
  },
  {
    id: "listVaultTree",
    method: "get",
    path: "/vaults/{id}/tree",
    summary: "List the folders and files in a vault folder",
    tag: "Vaults",
    scope: "vaults:read",
    params: ["id"],
    query: VaultTreeQuery,
    response: VaultTree,
  },
  {
    id: "listServiceAccounts",
    method: "get",
    path: "/admin/service-accounts",
    summary: "List service accounts and their tokens",
    tag: "Service accounts",
    scope: "session",
    response: ServiceAccountList,
  },
  {
    id: "createServiceAccount",
    method: "post",
    path: "/admin/service-accounts",
    summary: "Create a service account",
    tag: "Service accounts",
    scope: "session",
    body: ServiceAccountBody,
    response: ServiceAccount,
    status: 201,
  },
  {
    id: "deleteServiceAccount",
    method: "delete",
    path: "/admin/service-accounts/{id}",
    summary: "Deprovision a service account and revoke its tokens",
    tag: "Service accounts",
    scope: "session",
    params: ["id"],
    status: 204,
  },
  {
    id: "createToken",
    method: "post",
    path: "/admin/service-accounts/{id}/tokens",
    summary: "Issue a token; the secret is returned once",
    tag: "Service accounts",
    scope: "session",
    params: ["id"],
    body: TokenBody,
    response: IssuedToken,
    status: 201,
  },
  {
    id: "revokeToken",
    method: "post",
    path: "/admin/service-accounts/{id}/tokens/{tokenId}/revoke",
    summary: "Revoke a token at once",
    tag: "Service accounts",
    scope: "session",
    params: ["id", "tokenId"],
    status: 204,
  },
  {
    id: "rotateToken",
    method: "post",
    path: "/admin/service-accounts/{id}/tokens/{tokenId}/rotate",
    summary: "Issue a replacement; the old token stops working after 24 hours",
    tag: "Service accounts",
    scope: "session",
    params: ["id", "tokenId"],
    response: IssuedToken,
    status: 201,
  },
];

const schemaOf = (type: z.ZodType) => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(type, { io: "output" }) as Record<
    string,
    unknown
  >;
  return schema;
};

const queryParameters = (query: z.ZodObject) => {
  const json = z.toJSONSchema(query, { io: "input" }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, schema]) => ({
    name,
    in: "query",
    required: json.required?.includes(name) ?? false,
    schema,
  }));
};

/** The OpenAPI 3.1 document, built from the same schemas the routes parse with. */
export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const status = op.status ?? 200;
    const parameters = [
      ...(op.params ?? []).map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      })),
      ...(op.query ? queryParameters(op.query) : []),
    ];
    const success = op.contentType
      ? { description: "OK", content: { [op.contentType]: { schema: { type: "string" } } } }
      : op.response
        ? {
            description: status === 201 ? "Created" : "OK",
            content: { "application/json": { schema: schemaOf(op.response) } },
          }
        : { description: "No content" };
    const error = (description: string) => ({
      description,
      content: { "application/json": { schema: schemaOf(ErrorBody) } },
    });
    const entry = paths[op.path] ?? {};
    paths[op.path] = entry;
    entry[op.method] = {
      operationId: op.id,
      summary: op.summary,
      tags: [op.tag],
      security: op.scope === "session" ? [{ session: [] }] : [{ bearer: [] }],
      ...(op.scope === "session"
        ? {}
        : { "x-required-scope": op.scope === "any_token" ? null : op.scope }),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: schemaOf(op.body) } },
            },
          }
        : {}),
      responses: {
        [String(status)]: success,
        "401": error("Missing, expired or revoked credential"),
        "403": error("The token lacks the scope for this operation"),
        ...(op.query ? { "422": error("A parameter is out of range") } : {}),
        "429": error("More than 600 requests in a minute"),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "LegalLabs public API",
      version: "1.0.0",
      description:
        "Read-only access to audit events, query history and vaults for a service account. Tokens begin with `cns_`, are shown once, expire within 365 days and are limited to the scopes they were issued with.",
    },
    servers: [{ url: "/api/v1" }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A `cns_` API token" },
        session: { type: "apiKey", in: "cookie", name: "__Host-sid" },
      },
    },
  };
}
