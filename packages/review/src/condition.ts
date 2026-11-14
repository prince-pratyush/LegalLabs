import type { Condition, Customisation, FindingStatus } from "@legallabs/contracts";

/** Roles a party label can name; used to tell "a different role" from "role unknown". */
const ROLES = [
  "customer",
  "supplier",
  "vendor",
  "buyer",
  "seller",
  "licensor",
  "licensee",
  "discloser",
  "disclosing",
  "recipient",
  "receiving",
  "employer",
  "employee",
  "contractor",
  "landlord",
  "tenant",
  "lender",
  "borrower",
  "provider",
  "client",
] as const;

const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * Whether a rule's condition holds. "pending" means it depends on a rule that has not
 * finished yet. Semantics:
 * - paper: compared with the customisation.
 * - party_role: the party is a free-text label. It holds when the label names the role,
 *   fails when it names only other known roles, and holds when no role can be read from it
 *   (an unknown role must not silently drop a rule).
 * - jurisdiction: holds when the customisation's jurisdiction is in the list
 *   (case-insensitive; US-CA counts as US). Unknown jurisdiction fails: a governing-law rule is not applied to
 *   paper whose law we don't know, and its finding says so via status "skipped".
 * - rule_status: compares the other rule's final status; a rule that is out of scope,
 *   missing or itself skipped compares as "skipped".
 */
export function evaluateCondition(
  condition: Condition | undefined,
  ctx: { customisation: Customisation; statuses: ReadonlyMap<string, FindingStatus | "pending"> },
): boolean | "pending" {
  if (!condition) return true;
  switch (condition.kind) {
    case "paper":
      return ctx.customisation.paper === condition.equals;
    case "party_role": {
      const named = new Set(words(ctx.customisation.party));
      const want = words(condition.equals);
      if (want.length > 0 && want.every((w) => named.has(w))) return true;
      return !ROLES.some((r) => named.has(r));
    }
    case "jurisdiction": {
      const j = ctx.customisation.jurisdiction?.trim().toLowerCase();
      if (!j) return false;
      // A sub-jurisdiction falls under its parent: "US" holds for US-CA paper.
      return condition.in.some((c) => {
        const want = c.toLowerCase();
        return j === want || j.startsWith(`${want}-`);
      });
    }
    case "rule_status": {
      const status = ctx.statuses.get(condition.rule_id) ?? "skipped";
      if (status === "pending") return "pending";
      return status === condition.equals;
    }
  }
}

export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case "paper":
      return `applies only on ${condition.equals} paper`;
    case "party_role":
      return `applies only when acting as ${condition.equals}`;
    case "jurisdiction":
      return `applies only under ${condition.in.join(", ")} law`;
    case "rule_status":
      return `applies only when another rule is ${condition.equals.replace("_", " ")}`;
  }
}
