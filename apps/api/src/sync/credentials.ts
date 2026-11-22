import type pg from "pg";
import type { SecretBox } from "../admin-models/secrets.js";
import { asWorker } from "../db.js";
import { ProviderError, type SyncProvider, type TokenSet } from "./types.js";

/**
 * Opens a connection's sealed OAuth tokens (admin.secret, the same machinery as provider keys)
 * and renews them. The app role can seal but never read; reading goes through the worker's
 * function, and a renewed set is sealed again in place.
 */
export function createCredentials(pool: pg.Pool, secrets: SecretBox, now: () => number = Date.now) {
  return {
    seal: (set: TokenSet) => secrets.seal(JSON.stringify(set)),

    /**
     * Returns a runner for provider calls: it passes the current access token, and on a 401
     * renews the token once and repeats the call.
     */
    async session(workspaceId: string, secretRef: string, provider: SyncProvider) {
      const sealed = await asWorker(
        pool,
        async (w) =>
          (
            await w.query<{ s: Buffer | null }>("select admin.read_secret($1, $2) s", [
              workspaceId,
              secretRef,
            ])
          ).rows[0]?.s ?? null,
      );
      if (!sealed) throw new ProviderError("AUTH_REVOKED", "The stored connection is gone.");
      let set = JSON.parse(secrets.open(sealed)) as TokenSet;
      const renew = async () => {
        set = await provider.refresh(set.refreshToken);
        const blob = secrets.seal(JSON.stringify(set));
        await asWorker(pool, (w) =>
          w.query("select content.rotate_sync_secret($1, $2, $3)", [workspaceId, secretRef, blob]),
        );
      };
      if (set.expiresAt - now() < 60_000) await renew();
      return async <T>(f: (accessToken: string) => Promise<T>): Promise<T> => {
        try {
          return await f(set.accessToken);
        } catch (err) {
          if (!(err instanceof ProviderError) || err.code !== "TOKEN_EXPIRED") throw err;
          await renew();
          return f(set.accessToken);
        }
      };
    },
  };
}
