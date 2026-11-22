import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { asApp, type Identity } from "../../db.js";
import { type Client, type Principal, uaHash } from "../auth.js";
import type { FetchPolicy } from "./fetch.js";
import { createRp, RpError } from "./rp.js";
import { insertSession } from "./session.js";

const NOBODY: Identity = { userId: null, workspaceId: null };
const REQUEST_SECONDS = 10 * 60;
// Values in an ID token's amr (RFC 8176) that mean a second factor was used.
const MFA_AMR = new Set(["mfa", "hwk", "otp", "swk"]);

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const random = () => randomBytes(32).toString("base64url");

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  iss?: string;
}

export type OidcResult =
  | { ok: true; token: string; principal: Principal; returnTo: string; mfa: boolean }
  | { ok: true; pending: SecondStep; returnTo: string }
  | { ok: false; reason: string };

export interface Oidc {
  /** Null when the workspace has no enabled provider. */
  begin(
    workspaceSlug: string,
    opts: { returnTo?: string | null },
  ): Promise<{ url: string; binding: string } | null>;
  complete(
    params: CallbackParams,
    binding: string | undefined,
    client: Client,
  ): Promise<OidcResult>;
}

/** A second factor the app still wants because the IdP did not assert one. */
export interface SecondStep {
  kind: "challenge" | "enrol";
  mfaToken: string;
  methods: string[];
}

export interface OidcOptions {
  /** Owed when the IdP asserted no MFA; null means the policy asks nothing more. */
  secondFactor?: (
    who: { userId: string; workspaceId: string },
    client: Client,
  ) => Promise<SecondStep | null>;
  /** The public address of this API, which the IdP redirects back to. */
  baseUrl: string;
  policy?: FetchPolicy;
  now?: () => number;
}

// Relative paths only, so the callback can't be turned into an open redirect.
export const safeReturnTo = (value: string | null | undefined): string | null =>
  value && /^\/(?![/\\])[\w\-./?=&%~+]*$/.test(value) && value.length <= 512 ? value : null;

export function createOidc(pool: pg.Pool, opts: OidcOptions): Oidc {
  const rp = createRp({
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const redirectUri = `${opts.baseUrl.replace(/\/$/, "")}/auth/oidc/callback`;

  return {
    async begin(workspaceSlug, { returnTo }) {
      const config = await asApp(pool, NOBODY, async (db) => {
        const { rows } = await db.query<{
          workspace_id: string;
          issuer: string;
          client_id: string;
          scopes: string[];
        }>("select * from core.oidc_login_config($1)", [workspaceSlug]);
        return rows[0];
      });
      if (!config) return null;
      const meta = await rp.metadata(config.issuer);

      const state = random();
      const nonce = random();
      const verifier = random();
      const binding = random();
      await asApp(pool, { userId: null, workspaceId: config.workspace_id }, (db) =>
        db.query("select core.oidc_begin_request($1, $2, $3, $4, $5, $6, $7)", [
          config.workspace_id,
          sha256(state),
          sha256(binding),
          nonce,
          verifier,
          safeReturnTo(returnTo),
          REQUEST_SECONDS,
        ]),
      );

      const url = new URL(meta.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: config.client_id,
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })) {
        url.searchParams.set(k, v);
      }
      return { url: url.toString(), binding };
    },

    async complete(params, binding, client) {
      if (!params.state || !binding) return { ok: false, reason: "missing_state" };
      const req = await asApp(pool, NOBODY, async (db) => {
        const { rows } = await db.query<{
          status: string;
          workspace_id: string;
          nonce: string | null;
          code_verifier: string | null;
          return_to: string | null;
          issuer: string | null;
          client_id: string | null;
          client_secret: string | null;
          require_mfa_claim: boolean | null;
          mfa_acr_values: string[] | null;
        }>("select * from core.oidc_consume_request($1, $2)", [
          sha256(params.state ?? ""),
          sha256(binding),
        ]);
        return rows[0];
      });
      if (!req) return { ok: false, reason: "unknown_state" };

      const workspaceId = req.workspace_id;
      const fail = async (
        reason: string,
        details: Record<string, unknown> = {},
        userId: string | null = null,
      ): Promise<OidcResult> => {
        await asApp(pool, { userId: null, workspaceId }, (db) =>
          db.query(
            "select admin.append_audit_event('login.failure', 'system', null, $1, $2, $3, $4, $5)",
            [
              userId ? "user" : null,
              userId,
              JSON.stringify({ method: "oidc", reason, ...details }),
              client.ip,
              uaHash(client),
            ],
          ),
        );
        return { ok: false, reason };
      };

      if (req.status === "replayed") return fail("replayed_request");
      if (req.status === "expired") return fail("request_expired");
      if (
        req.status !== "ok" ||
        !req.issuer ||
        !req.client_id ||
        !req.nonce ||
        !req.code_verifier
      ) {
        return fail("provider_disabled");
      }
      if (params.error) return fail("idp_error", { error: params.error.slice(0, 64) });

      try {
        const meta = await rp.metadata(req.issuer);
        // RFC 9207: a response from another issuer than the one we sent the user to is a mix-up.
        if (
          params.iss !== undefined
            ? params.iss !== req.issuer
            : meta.authorization_response_iss_parameter_supported
        ) {
          return fail("iss_mismatch");
        }
        if (!params.code) return fail("missing_code");
        const idToken = await rp.exchangeCode(meta, {
          code: params.code,
          verifier: req.code_verifier,
          redirectUri,
          clientId: req.client_id,
          clientSecret: req.client_secret,
        });
        const claims = await rp.verifyIdToken(idToken, {
          issuer: req.issuer,
          clientId: req.client_id,
          nonce: req.nonce,
          jwksUri: meta.jwks_uri,
        });

        const subject = claims.sub as string;
        const amr = Array.isArray(claims.amr) ? claims.amr : [];
        const mfa =
          amr.some((v) => typeof v === "string" && MFA_AMR.has(v)) ||
          (typeof claims.acr === "string" && (req.mfa_acr_values ?? []).includes(claims.acr));
        if (req.require_mfa_claim && !mfa) return fail("mfa_required", { subject });

        const email = typeof claims.email === "string" ? claims.email : null;
        // Only a literal true counts: some IdPs send "false" as a string.
        const verified = claims.email_verified === true;

        const outcome = await asApp(pool, { userId: null, workspaceId }, async (db) => {
          const { rows } = await db.query<{
            outcome: string;
            user_id: string | null;
            scim_enabled: boolean;
          }>("select * from core.oidc_resolve_user($1, $2, $3, $4, $5)", [
            workspaceId,
            req.issuer,
            subject,
            email,
            verified,
          ]);
          const r = rows[0];
          if (!r || (r.outcome !== "ok" && r.outcome !== "first_link") || !r.user_id) {
            const reason = r?.outcome ?? "no_provider";
            await db.query(
              "select admin.append_audit_event('login.failure', 'system', null, $1, $2, $3, $4, $5)",
              [
                r?.user_id ? "user" : null,
                r?.user_id ?? null,
                JSON.stringify({
                  method: "oidc",
                  reason,
                  subject,
                  scim_enabled: r?.scim_enabled ?? false,
                }),
                client.ip,
                uaHash(client),
              ],
            );
            return { reason };
          }
          // From here the transaction acts as the person, as password sign-in does.
          await db.query("select set_config('app.user_id', $1, true)", [r.user_id]);
          if (r.outcome === "first_link") {
            await db.query(
              "select admin.append_audit_event('sso.identity_linked', 'user', $1::uuid, 'user', $1::text, $2, $3, $4)",
              [
                r.user_id,
                JSON.stringify({ issuer: req.issuer, subject }),
                client.ip,
                uaHash(client),
              ],
            );
          }
          // The app's own policy applies when the IdP did not strengthen the sign-in.
          if (!mfa && opts.secondFactor) return { who: { userId: r.user_id, workspaceId } };
          const session = await insertSession(db, { userId: r.user_id, workspaceId }, client, {
            mfa,
            details: { method: "oidc", mfa },
          });
          return { session };
        });
        if ("reason" in outcome) return { ok: false, reason: outcome.reason };
        const returnTo = safeReturnTo(req.return_to) ?? "/";
        const who = "who" in outcome ? outcome.who : undefined;
        if (who) {
          const pending = await opts.secondFactor?.(who, client);
          if (pending) return { ok: true, pending, returnTo };
          const session = await asApp(pool, who, (db) =>
            insertSession(db, who, client, {
              mfa: false,
              details: { method: "oidc", mfa: false },
            }),
          );
          return { ok: true, ...session, returnTo, mfa: false };
        }
        if (!("session" in outcome)) return { ok: false, reason: "internal" };
        return {
          ok: true,
          ...outcome.session,
          returnTo: safeReturnTo(req.return_to) ?? "/",
          mfa,
        };
      } catch (err) {
        if (err instanceof RpError) {
          return fail(err.reason, err.message === err.reason ? {} : { detail: err.message });
        }
        // Network and parsing failures: the user is turned away and the cause is kept short.
        return fail("idp_unreachable", {
          detail: err instanceof Error ? err.message.slice(0, 100) : "",
        });
      }
    },
  };
}
