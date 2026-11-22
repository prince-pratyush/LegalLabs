import { createHash, randomBytes } from "node:crypto";
import { base32Encode } from "./totp.js";

export const RECOVERY_CODES = 10;

/** 80 bits each, shown once as four groups of four. */
export function generateRecoveryCodes(count = RECOVERY_CODES): string[] {
  return Array.from({ length: count }, () => {
    const text = base32Encode(randomBytes(10));
    return text.match(/.{4}/g)?.join("-") ?? text;
  });
}

// People retype these, so case, dashes and spaces are ignored.
export const normaliseRecoveryCode = (code: string) =>
  code.replace(/[^a-z2-7]/gi, "").toUpperCase();

// Plain SHA-256 is enough: the codes are random, not chosen, so there is nothing to guess from.
export const hashRecoveryCode = (code: string) =>
  createHash("sha256").update(normaliseRecoveryCode(code)).digest();
