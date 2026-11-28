import { createGateway, type Message, type ModelProvider } from "@legallabs/model-gateway";
import { describe, expect, it } from "vitest";
import { generateRules, parseRules, partsOf, verifyQuote } from "./generate.js";
import { assignIds, conditionsHold, uuid7 } from "./playbooks.js";

const DOC = "0190a000-0000-7000-8000-000000000001";

describe("parseRules", () => {
  it("reads the JSON inside prose or a fence and drops what doesn't fit", () => {
    const rules = parseRules(
      'Sure.\n```json\n{"rules":[{"title":"Term","standard_position":"Two years.","fallbacks":["One year.",""],"flag":"yes","source_quote":"two years"},{"title":"No position"}]}\n```',
    );
    expect(rules).toEqual([
      {
        draft: {
          title: "Term",
          standard_position: "Two years.",
          fallbacks: ["One year."],
          flag: false,
          actions: [],
        },
        quote: "two years",
      },
    ]);
    expect(parseRules("no json here")).toEqual([]);
    expect(parseRules('{"rules": "nope"}')).toEqual([]);
  });
});

describe("partsOf", () => {
  it("keeps whole pages together and cuts only a page that is too long", () => {
    const pages = [
      { page_no: 1, text: "a".repeat(40) },
      { page_no: 2, text: "b".repeat(40) },
      { page_no: 3, text: "c".repeat(150) },
    ];
    const parts = partsOf(pages, 100);
    expect(parts.join("").replaceAll("\n", "")).toBe(pages.map((p) => p.text).join(""));
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts[0]).toBe(`${"a".repeat(40)}\n${"b".repeat(40)}`);
  });
});

describe("verifyQuote", () => {
  const pages = [{ page_no: 1, text: "The  supplier’s liability is capped at the fees paid." }];
  it("finds a quote despite spacing and quote marks, returning the document's words", () => {
    expect(verifyQuote(DOC, pages, "supplier's liability  is capped")).toEqual({
      document_id: DOC,
      quote: "supplier’s liability is capped",
      verified: true,
    });
  });
  it("returns null for a quote that isn't there", () => {
    expect(verifyQuote(DOC, pages, "liability is unlimited for all claims")).toBeNull();
    expect(verifyQuote(DOC, pages, undefined)).toBeNull();
  });
});

describe("generateRules", () => {
  const provider = (reply: (messages: readonly Message[]) => string): ModelProvider => ({
    complete: async ({ messages }) => ({
      text: reply(messages),
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });

  it("splits a contract for a small model and merges rules by title", async () => {
    const seen: string[] = [];
    const systems: string[] = [];
    const gateway = createGateway({
      providers: {
        ollama: provider((messages) => {
          seen.push(messages[1]?.content ?? "");
          systems.push(messages[0]?.content ?? "");
          return JSON.stringify({
            rules: [
              { title: "Term", standard_position: "Two years." },
              { title: `Part ${seen.length}`, standard_position: "x" },
            ],
          });
        }),
      },
      recordUsage: async () => {},
    });
    const pages = Array.from({ length: 6 }, (_, i) => ({
      page_no: i + 1,
      text: `Page ${i + 1}. ${"word ".repeat(1500)}`,
    }));
    const result = await generateRules(gateway, {
      workspaceId: DOC,
      userId: "u",
      documentId: DOC,
      contractType: "MSA",
      pages,
    });
    expect(result.parts_total).toBeGreaterThan(1);
    // Past eight parts the rest is reported unread rather than sent.
    expect(result.parts_total).toBe(12);
    expect(result.parts_read).toBe(8);
    expect(result.rules.filter((r) => r.title === "Term")).toHaveLength(1);
    // Each part is fenced by a fresh random tag the contract can't predict.
    // Typed by a user, the contract type sits inside the fence too, never in the system prompt.
    expect(seen[0]).toMatch(
      /^<contract-type-([0-9a-f]{24})>MSA<\/contract-type-\1>\n<contract-\1>/,
    );
    expect(systems[0]).not.toContain("MSA");
  });

  it("fails as unavailable when no model answers", async () => {
    const gateway = createGateway({ providers: {}, recordUsage: async () => {} });
    await expect(
      generateRules(gateway, {
        workspaceId: DOC,
        userId: "u",
        documentId: DOC,
        contractType: "MSA",
        pages: [{ page_no: 1, text: "Text" }],
      }),
    ).rejects.toMatchObject({ reason: "MODEL_UNAVAILABLE" });
  });
});

describe("assignIds", () => {
  it("keeps known ids, renews unknown ones and points conditions at the new id", () => {
    const keep = uuid7();
    const previous = [
      {
        id: keep,
        ordinal: 0,
        title: "A",
        standard_position: "a",
        fallbacks: [],
        flag: false,
        actions: [],
        provenance: { document_id: DOC, quote: "q", verified: true },
      },
    ];
    const invented = uuid7();
    const rules = assignIds(
      [
        { id: keep, title: "A", standard_position: "a", fallbacks: [], flag: false, actions: [] },
        {
          id: invented,
          title: "B",
          standard_position: "b",
          fallbacks: [],
          flag: false,
          actions: [],
        },
        {
          title: "C",
          standard_position: "c",
          fallbacks: [],
          flag: false,
          actions: [],
          condition: { kind: "rule_status", rule_id: invented, equals: "not_acceptable" },
        },
      ],
      previous,
    );
    expect(rules[0]).toMatchObject({ id: keep, ordinal: 0, provenance: { verified: true } });
    expect(rules[1]?.id).not.toBe(invented);
    expect(rules[2]?.condition).toEqual({
      kind: "rule_status",
      rule_id: rules[1]?.id,
      equals: "not_acceptable",
    });
  });

  it("drops provenance once the standard position is rewritten", () => {
    const keep = uuid7();
    const previous = [
      {
        id: keep,
        ordinal: 0,
        title: "A",
        standard_position: "a",
        fallbacks: [],
        flag: false,
        actions: [],
        provenance: { document_id: DOC, quote: "q", verified: true },
      },
    ];
    const base = { id: keep, title: "A", fallbacks: [], flag: false, actions: [] };
    const [same] = assignIds([{ ...base, standard_position: "a", guidance: "why" }], previous);
    expect(same?.provenance).toEqual(previous[0]?.provenance);
    const [rewritten] = assignIds([{ ...base, standard_position: "b" }], previous);
    expect(rewritten).not.toHaveProperty("provenance");
  });
});

describe("conditionsHold", () => {
  const rule = (id: string, on?: string) => ({
    id,
    ordinal: 0,
    title: id,
    standard_position: "x",
    fallbacks: [],
    flag: false,
    actions: [],
    ...(on
      ? { condition: { kind: "rule_status" as const, rule_id: on, equals: "acceptable" as const } }
      : {}),
  });
  const [a, b, c] = [uuid7(), uuid7(), uuid7()];
  it("accepts a chain and refuses a missing target, a self reference and a loop", () => {
    expect(conditionsHold([rule(a), rule(b, a), rule(c, b)])).toBe(true);
    expect(conditionsHold([rule(a, uuid7())])).toBe(false);
    expect(conditionsHold([rule(a, a)])).toBe(false);
    expect(conditionsHold([rule(a, c), rule(b, a), rule(c, b)])).toBe(false);
  });
});
