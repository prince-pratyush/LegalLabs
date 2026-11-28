import { SsoInput, type SsoSettings } from "@legallabs/contracts";
import type pg from "pg";
import type { SecretBox } from "../../admin-models/secrets.js";
import { asApp } from "../../db.js";
import type { FetchPolicy } from "../../net/fetch.js";
import type { Client, Principal } from "../auth.js";
import type { OidcProviders } from "./providers.js";
import { createRp } from "./rp.js";

/** What an administrator does to set up single sign-on on a running installation. */

export class SsoRefused extends Error {
  constructor(
    readonly status: 403 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SsoAdminOptions {
  providers: OidcProviders;
  /** The public address of this API, which the identity provider redirects back to. */
  baseUrl: string;
  policy?: FetchPolicy;
  secrets?: SecretBox;
}

export function createSsoAdmin(pool: pg.Pool, opts: SsoAdminOptions) {
  const redirectUri = `${opts.baseUrl.replace(/\/$/, "")}/auth/oidc/callback`;
  const insecureDev = opts.policy?.insecureDev ?? false;

  const may = (p: Principal) =>
    asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ read: boolean; change: boolean }>(
        "select core.has_permission('admin.config') as read, core.has_permission('*') as change",
      );
      return rows[0] ?? { read: false, change: false };
    });

  async function get(p: Principal): Promise<SsoSettings> {
    const allowed = await may(p);
    if (!allowed.read) {
      throw new SsoRefused(403, "FORBIDDEN", "Needs the admin.config permission.");
    }
    const config = await opts.providers.get(p);
    const hasSecret = await asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ has: boolean }>(
        "select core.oidc_has_client_secret() as has",
      );
      return rows[0]?.has === true;
    });
    return {
      configured: config !== null,
      issuer: config?.issuer ?? "",
      client_id: config?.clientId ?? "",
      scopes: config?.scopes ?? ["openid", "email", "profile"],
      enabled: config?.enabled ?? false,
      link_by_email: config?.linkByEmail ?? false,
      require_mfa_claim: config?.requireMfaClaim ?? false,
      has_secret: hasSecret,
      redirect_uri: redirectUri,
      secret_storage: opts.secrets !== undefined,
      can_change: allowed.change,
    };
  }

  /** Reads the provider's discovery document through the guarded fetch, uncached. */
  async function discover(issuer: string) {
    try {
      await createRp({ policy: { deadlineMs: 10_000, ...opts.policy } }).metadata(issuer);
    } catch {
      // Why it failed stays here: the answer must not report on what is at an address.
      throw new SsoRefused(
        422,
        "DISCOVERY_FAILED",
        "Couldn't read this issuer's configuration. Check the address, which must be public " +
          "and use https.",
      );
    }
  }

  return {
    get,

    async put(p: Principal, input: SsoInput, client: Client): Promise<SsoSettings> {
      const value = SsoInput.parse(input);
      if (!(await may(p)).change) {
        throw new SsoRefused(
          403,
          "FORBIDDEN",
          "Only an administrator with every permission can change single sign-on.",
        );
      }
      const issuer = value.issuer.replace(/\/$/, "");
      const url = new URL(issuer);
      const secure = url.protocol === "https:" || (insecureDev && url.protocol === "http:");
      if (!secure || url.search || url.hash || url.username || url.password) {
        throw new SsoRefused(422, "INVALID_ISSUER", "The issuer must be a plain https address.");
      }
      if (value.client_secret && !opts.secrets) {
        throw new SsoRefused(
          503,
          "KEY_STORAGE_UNAVAILABLE",
          "This installation has no secret key configured, so a client secret can't be stored.",
        );
      }
      const before = await get(p);
      // A saved secret belongs to the provider it was entered for, and is never sent elsewhere.
      if (before.has_secret && before.issuer !== issuer && value.client_secret === undefined) {
        throw new SsoRefused(422, "SECRET_REQUIRED", "Enter the client secret for this issuer.");
      }
      if (value.enabled) await discover(issuer);
      const kept = await opts.providers.get(p);
      await opts.providers.put(
        p,
        {
          issuer,
          clientId: value.client_id,
          scopes: [...new Set(["openid", ...value.scopes])],
          enabled: value.enabled,
          linkByEmail: value.link_by_email,
          requireMfaClaim: value.require_mfa_claim,
          groupsClaim: kept?.groupsClaim ?? null,
          roleMapping: kept?.roleMapping ?? {},
          mfaAcrValues: kept?.mfaAcrValues ?? [],
        },
        value.client_secret,
        client,
      );
      return get(p);
    },
  };
}

export type SsoAdmin = ReturnType<typeof createSsoAdmin>;
