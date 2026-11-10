import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

const cost = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, cost);
}

let decoy: Promise<string> | undefined;

// A missing account still costs a full hash, so response time doesn't reveal who exists.
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (stored !== null) return verify(stored, password);
  decoy ??= hashPassword(randomBytes(32).toString("hex"));
  await verify(await decoy, password);
  return false;
}
