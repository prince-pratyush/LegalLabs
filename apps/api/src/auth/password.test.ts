import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("passwords", () => {
  it("are hashed with Argon2id at the OWASP minimum cost", async () => {
    expect(await hashPassword("correct horse battery")).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/,
    );
  });

  it("verify only against the password that made the hash", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword(stored, "correct horse battery")).toBe(true);
    expect(await verifyPassword(stored, "correct horse batterz")).toBe(false);
  });

  it("never verify when there is no stored hash", async () => {
    expect(await verifyPassword(null, "anything at all")).toBe(false);
  });
});
