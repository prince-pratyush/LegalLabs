import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * True when `signature` is the HMAC-SHA256 of `message` in the given encoding, spelt exactly as
 * Node writes it. The comparison takes the same time wherever the two differ. An empty secret
 * verifies nothing.
 */
export function hmacMatches(
  secret: string | Buffer,
  message: string | Buffer,
  signature: string | undefined,
  encoding: "hex" | "base64",
): boolean {
  if (secret.length === 0 || signature === undefined) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(message).digest(encoding));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Checks a webhook signed as `v0=hex(HMAC("v0:{timestamp}:{raw body}"))`, the Slack scheme, with
 * the timestamp in Unix seconds and within the window either side of now. The window does not
 * stop a repeat inside it: the receiver must also ignore events it has already seen.
 */
export function verifyTimestamped(
  secret: string,
  rawBody: Buffer,
  given: { timestamp?: string | undefined; signature?: string | undefined },
  options: { now?: number; windowSeconds?: number } = {},
): boolean {
  const { now = Date.now(), windowSeconds = 300 } = options;
  const { timestamp, signature } = given;
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > windowSeconds) return false;
  if (!signature?.startsWith("v0=")) return false;
  const message = Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody]);
  return hmacMatches(secret, message, signature.slice(3), "hex");
}
