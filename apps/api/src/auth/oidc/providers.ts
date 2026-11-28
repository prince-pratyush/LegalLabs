import type pg from "pg";
import type { SecretBox } from "../../admin-models/secrets.js";
import { asApp } from "../../db.js";
import { audit } from "../audit.js";
import type { Client, Principal } from "../auth.js";

export interface ProviderConfig {
  issuer: string;
  clientId: string;
  scopes: string[];
  enabled: boolean;
  groupsClaim: string | null;
  roleMapping: Record<string, string>;
  requireMfaClaim: boolean;
  mfaAcrValues: string[];
  linkByEmail: boolean;
}

export type ProviderInput = Partial<ProviderConfig> & { issuer: string; clientId: string };

export interface OidcProviders {
  get(principal: Principal): Promise<ProviderConfig | null>;
  /** `clientSecret`: a string stores it, null clears it, undefined leaves it alone. */
  put(
    principal: Principal,
    input: ProviderInput,
    clientSecret: string | null | undefined,
    client: Client,
  ): Promise<ProviderConfig>;
}

interface Row {
  issuer: string;
  client_id: string;
  scopes: string[];
  enabled: boolean;
  groups_claim: string | null;
  role_mapping: Record<string, string>;
  require_mfa_claim: boolean;
  mfa_acr_values: string[];
  link_by_email: boolean;
}

const toConfig = (r: Row): ProviderConfig => ({
  issuer: r.issuer,
  clientId: r.client_id,
  scopes: r.scopes,
  enabled: r.enabled,
  groupsClaim: r.groups_claim,
  roleMapping: r.role_mapping,
  requireMfaClaim: r.require_mfa_claim,
  mfaAcrValues: r.mfa_acr_values,
  linkByEmail: r.link_by_email,
});

// Marks what the app sealed, so a value stored any other way is never sent to a provider.
const SEALED = "sealed:v1:";

export const sealSecret = (box: SecretBox, secret: string) =>
  `${SEALED}${box.seal(secret).toString("base64")}`;

/** Null for anything that was not sealed with this key. */
export function openSecret(box: SecretBox | undefined, stored: string): string | null {
  if (!box || !stored.startsWith(SEALED)) return null;
  try {
    return box.open(Buffer.from(stored.slice(SEALED.length), "base64"));
  } catch {
    return null;
  }
}

export class SecretStorageUnavailable extends Error {
  constructor() {
    super("This installation has no key to seal a secret with (LEGALLABS_SECRETS_KEY).");
  }
}

export function createOidcProviders(
  pool: pg.Pool,
  opts: { insecureDev?: boolean; secrets?: SecretBox } = {},
): OidcProviders {
  return {
    async get(principal) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<Row>(
          "select * from core.oidc_provider where workspace_id = $1",
          [principal.workspaceId],
        );
        return rows[0] ? toConfig(rows[0]) : null;
      });
    },

    async put(principal, input, clientSecret, client) {
      const issuer = input.issuer.replace(/\/$/, "");
      if (!issuer.startsWith("https://") && !(opts.insecureDev && issuer.startsWith("http://"))) {
        throw new Error("The issuer must be an https address.");
      }
      let sealed = clientSecret;
      if (clientSecret) {
        if (!opts.secrets) throw new SecretStorageUnavailable();
        sealed = sealSecret(opts.secrets, clientSecret);
      }
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<Row>(
          `insert into core.oidc_provider
             (workspace_id, issuer, client_id, scopes, enabled, groups_claim, role_mapping,
              require_mfa_claim, mfa_acr_values, link_by_email)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (workspace_id) do update set
             issuer = excluded.issuer, client_id = excluded.client_id, scopes = excluded.scopes,
             enabled = excluded.enabled, groups_claim = excluded.groups_claim,
             role_mapping = excluded.role_mapping, require_mfa_claim = excluded.require_mfa_claim,
             mfa_acr_values = excluded.mfa_acr_values, link_by_email = excluded.link_by_email,
             updated_at = now()
           returning *`,
          [
            principal.workspaceId,
            issuer,
            input.clientId,
            input.scopes ?? ["openid", "email", "profile"],
            input.enabled ?? false,
            input.groupsClaim ?? null,
            JSON.stringify(input.roleMapping ?? {}),
            input.requireMfaClaim ?? false,
            input.mfaAcrValues ?? [],
            input.linkByEmail ?? false,
          ],
        );
        if (sealed !== undefined) {
          await db.query("select core.set_oidc_client_secret($1)", [sealed]);
        }
        const row = rows[0] as Row;
        await audit(
          db,
          principal,
          client,
          "sso.provider_configured",
          "workspace",
          principal.workspaceId,
          {
            issuer,
            enabled: row.enabled,
            link_by_email: row.link_by_email,
            require_mfa_claim: row.require_mfa_claim,
            secret_changed: clientSecret !== undefined,
          },
        );
        return toConfig(row);
      });
    },
  };
}
