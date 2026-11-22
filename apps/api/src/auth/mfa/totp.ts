import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 with the defaults every authenticator app supports: SHA-1, 6 digits, 30 s steps.
export const STEP_SECONDS = 30;
export const DIGITS = 6;
// One step either side absorbs clock drift between the phone and the server.
export const WINDOW = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function generateSecret(): Buffer {
  // 160 bits, the length RFC 4226 recommends for SHA-1.
  return randomBytes(20);
}

export function stepOf(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** RFC 4226 HOTP: the code for one counter value. */
export function hotp(secret: Uint8Array, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = (mac[19] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Returns the time step the code belongs to, or null. The caller stores that step and refuses
 * any step at or below it, which is what stops a code being used twice.
 */
export function matchCode(secret: Uint8Array, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = stepOf(nowMs);
  let hit: number | null = null;
  // Every step is checked, whatever the outcome, so timing doesn't say which one matched.
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(given, expected)) hit = step;
  }
  return hit;
}

export function otpauthUri(secret: Uint8Array, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query}`;
}
