import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

/**
 * Seals provider keys and connector tokens with AES-256-GCM. The sealed form is
 * iv (12) + tag (16) + ciphertext, so a database dump alone cannot be read. The key lives in
 * the deployment's secret store (LEGALLABS_SECRETS_KEY, 32 bytes as base64), never in Postgres.
 */
export interface SecretBox {
  seal(plain: string): Buffer;
  open(sealed: Buffer): string;
  /** A fresh reference such as `sec_<32 hex>`. */
  newRef(): string;
}

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("LEGALLABS_SECRETS_KEY must be 32 bytes, base64 encoded");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(sealed) {
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
    newRef: () => `sec_${randomUUID().replaceAll("-", "")}`,
  };
}

/** Looks only for the shape of a provider key; used to keep keys out of logs and errors. */
const KEY_SHAPES = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

/** Removes every known secret value and anything key-shaped from text bound for a log or error. */
export function scrub(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  for (const shape of KEY_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}
