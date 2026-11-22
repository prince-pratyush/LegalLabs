import { describe, expect, it } from "vitest";
import { base32Encode, hotp, matchCode, otpauthUri, stepOf } from "./totp.js";

// RFC 6238 appendix B: the SHA-1 secret and its 8-digit codes.
const rfcSecret = Buffer.from("12345678901234567890");
const vectors: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it.each(vectors)("matches the RFC 6238 vector at t=%i", (seconds, expected) => {
    expect(hotp(rfcSecret, stepOf(seconds * 1000), 8)).toBe(expected);
  });

  it("matches the RFC 4226 HOTP vectors", () => {
    const codes = ["755224", "287082", "359152", "969429", "338314", "254676"];
    codes.forEach((code, counter) => {
      expect(hotp(rfcSecret, counter)).toBe(code);
    });
  });

  const at = 1_700_000_000_000;
  const step = stepOf(at);

  it("accepts the current step and one either side, and reports which", () => {
    expect(matchCode(rfcSecret, hotp(rfcSecret, step), at)).toBe(step);
    expect(matchCode(rfcSecret, hotp(rfcSecret, step - 1), at)).toBe(step - 1);
    expect(matchCode(rfcSecret, hotp(rfcSecret, step + 1), at)).toBe(step + 1);
  });

  it("refuses codes outside the window and malformed input", () => {
    expect(matchCode(rfcSecret, hotp(rfcSecret, step - 2), at)).toBeNull();
    expect(matchCode(rfcSecret, hotp(rfcSecret, step + 2), at)).toBeNull();
    expect(matchCode(rfcSecret, "12345", at)).toBeNull();
    expect(matchCode(rfcSecret, "12345a", at)).toBeNull();
    expect(matchCode(rfcSecret, "１２３４５６", at)).toBeNull();
  });

  it("encodes the secret as base32 for the authenticator app", () => {
    // RFC 4648 test vector.
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(rfcSecret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("builds an otpauth link with the fixed parameters", () => {
    const uri = new URL(otpauthUri(rfcSecret, "ana@acme.test", "LegalLabs"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/LegalLabs:ana@acme.test");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      issuer: "LegalLabs",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });
});
