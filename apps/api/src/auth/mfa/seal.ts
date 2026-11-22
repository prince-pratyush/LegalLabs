import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM: a stolen database copy holds sealed secrets, never one that makes a code.
const IV = 12;
const TAG = 16;

export function sealKey(raw: string | Buffer): Buffer {
  const key = typeof raw === "string" ? Buffer.from(raw, "base64") : raw;
  if (key.length !== 32) throw new Error("the MFA encryption key must be 32 bytes");
  return key;
}

/** `context` binds the secret to its owner, so a sealed value copied to another row won't open. */
export function seal(key: Buffer, plain: Uint8Array, context: string): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Uint8Array, context: string): Buffer | null {
  const bytes = Buffer.from(sealed);
  if (bytes.length < IV + TAG) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(IV, IV + TAG));
    return Buffer.concat([decipher.update(bytes.subarray(IV + TAG)), decipher.final()]);
  } catch {
    return null;
  }
}
