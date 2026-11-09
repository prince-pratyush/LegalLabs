import { describe, expect, it } from "vitest";
import { type Sources, type Verification, verifyCitation } from "./index.js";

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seededRandom(20261109);
const below = (limit: number) => Math.floor(random() * limit);
const pick = (items: readonly string[]) => items[below(items.length)] as string;

const PARTIES = ["Supplier", "Customer", "Licensor", "Contractor", "Landlord", "Tenant"];
const DUTIES = [
  "deliver the final report to",
  "indemnify and hold harmless",
  "give written notice to",
  "refund any prepaid fees to",
  "provide reasonable assistance to",
];
const EVENTS = ["termination", "the effective date", "a material breach", "the first invoice"];
const TAILS = [
  "any dispute arising from that obligation will be governed by this agreement",
  "the affected party's officers will confirm compliance in writing on request",
  "no waiver of that requirement is effective unless it is signed by both parties",
  "the first offer of settlement must be made in good faith before proceedings",
];

function clause(id: number): string {
  const party = pick(PARTIES);
  const other = pick(PARTIES.filter((name) => name !== party));
  const negated = below(4) === 0 ? "shall not" : "shall";
  const days = 5 + below(85);
  return (
    `Clause ${id}. The ${party} ${negated} ${pick(DUTIES)} the ${other} ` +
    `within ${days} days after ${pick(EVENTS)}, and ${pick(TAILS)} under section ${id}.`
  );
}

const CONFUSIONS: Record<string, string> = {
  a: "o",
  e: "c",
  h: "b",
  i: "l",
  l: "i",
  n: "r",
  u: "v",
};
const PROTECTED =
  /^(and|may|must|shall|not|no|nor|never|none|neither|non|or|unless|without|except)$/i;

// Letter-for-letter confusions only: a misread digit is refused by design.
function addScanErrors(text: string, budget: number): string {
  const words = [...text.matchAll(/\p{L}{4,}/gu)].filter((word) => !PROTECTED.test(word[0]));
  let result = text;
  for (let spent = 0; spent < budget && words.length > 0; spent++) {
    const [word] = words.splice(below(words.length), 1);
    if (word === undefined) break;
    const letters = [...word[0].matchAll(/[aehilnu]/g)];
    const letter = letters[below(letters.length)];
    if (letter === undefined) continue;
    const at = word.index + letter.index;
    result = result.slice(0, at) + CONFUSIONS[letter[0]] + result.slice(at + 1);
  }
  return result;
}

function addLayoutNoise(text: string): string {
  return text
    .replace(/ /g, () => pick([" ", " ", " ", "\n", "  ", " "]))
    .replace(/'/g, () => pick(["'", "’"]))
    .replace(/fi/g, () => pick(["fi", "ﬁ"]))
    .replace(/ff/g, () => pick(["ff", "ﬀ"]))
    .replace(/(?<=\p{Ll}{3})(?=\p{Ll}{3})/gu, () =>
      pick(["", "", "", "", "", "", "", "", "­", "-\n"]),
    );
}

interface Sample {
  page: string;
  quote: string;
  from: number;
  to: number;
}

let nextClause = 1;

function sample(): Sample {
  const clauses = Array.from({ length: 6 }, () => clause(nextClause++));
  const first = 1 + below(3);
  const count = 1 + below(2);
  const clean = clauses.slice(first, first + count).join(" ");
  const budget = below(2) === 0 ? 0 : Math.floor(clean.length * 0.02);

  const before = clauses.slice(0, first).map(addLayoutNoise).join(" ");
  const quoted = addLayoutNoise(addScanErrors(clean, budget));
  const after = clauses
    .slice(first + count)
    .map(addLayoutNoise)
    .join(" ");

  const from = before.length + 1;
  return { page: `${before} ${quoted} ${after}`, quote: clean, from, to: from + quoted.length };
}

const check = (page: string, quote: string): Promise<Verification> => {
  const sources: Sources = {
    documentPage: async () => page,
    webPage: async () => null,
    cellCitationStatuses: async () => null,
    authorityById: async () => null,
    authoritiesByCitation: async () => [],
    authorityPassages: async () => [],
  };
  return verifyCitation({ kind: "document", documentVersionId: "dv", page: 1, quote }, sources);
};

const ALTERATIONS: readonly ((quote: string) => string)[] = [
  (quote) => quote.replace("shall ", "shall not "),
  (quote) => quote.replace(/within (\d+) days/, (_, days) => `within ${Number(days) + 1} days`),
  (quote) => quote.replace(/ (the|that|any|and) /, " "),
  (quote) => quote.replace(/\b(Supplier|Customer|Licensor|Contractor|Landlord|Tenant)\b/, "Agent"),
];

describe("synthetic verification set", () => {
  it("verifies at least 99% of real quotes at their exact position", async () => {
    const total = 2000;
    let exact = 0;
    for (let i = 0; i < total; i++) {
      const { page, quote, from, to } = sample();
      const result = await check(page, quote);
      if (result.status === "ok" && "located" in result) {
        if (result.located?.from === from && result.located.to === to) exact++;
      }
    }
    expect(exact / total).toBeGreaterThanOrEqual(0.99);
  });

  it.each(ALTERATIONS.map((alter, i) => [i, alter] as const))(
    "never verifies altered quote kind %i",
    async (_, alter) => {
      for (let i = 0; i < 500; i++) {
        const { page, quote } = sample();
        const altered = alter(quote);
        expect(altered).not.toBe(quote);
        expect((await check(page, altered)).status).not.toBe("ok");
      }
    },
  );

  it("never verifies a real quote against the wrong page", async () => {
    for (let i = 0; i < 500; i++) {
      const { quote } = sample();
      const other = sample();
      expect((await check(other.page, quote)).status).not.toBe("ok");
    }
  });
});
