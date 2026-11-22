import type pg from "pg";
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

export function createOidcProviders(
  pool: pg.Pool,
  opts: { insecureDev?: boolean } = {},
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
            input.linkByEmail ?? true,
          ],
        );
        if (clientSecret !== undefined) {
          await db.query("select core.set_oidc_client_secret($1)", [clientSecret]);
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
            secret_changed: clientSecret !== undefined,
          },
        );
        return toConfig(row);
      });
    },
  };
}
