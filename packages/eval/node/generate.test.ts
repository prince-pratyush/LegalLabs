import { normaliseParagraph, starterPlaybook } from "@legallabs/contracts";
import { readDocx } from "@legallabs/docx";
import { describe, expect, it } from "vitest";
import { BOILERPLATE, CLAUSES, type Template, UNUSUAL } from "./clauses.ts";
import { buildContract, generateCorpus } from "./generate.ts";

const TEMPLATES: Template[] = ["nda", "msa"];
const words = (text: string) =>
  normaliseParagraph(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
const shingles = (text: string, n = 8) => {
  const w = words(text);
  return new Set(
    w.slice(0, Math.max(0, w.length - n + 1)).map((_, i) => w.slice(i, i + n).join(" ")),
  );
};

describe("clause variants", () => {
  it.each(TEMPLATES)("cover every %s starter rule exactly once", (template) => {
    const titles = starterPlaybook(template).rules?.map((r) => r.title) ?? [];
    expect(CLAUSES[template].map((c) => c.rule)).toEqual(titles);
  });

  it.each(TEMPLATES)("never reuse the %s starter's sample language", (template) => {
    const samples = (starterPlaybook(template).rules ?? []).flatMap((r) =>
      r.sample_language ? [...shingles(r.sample_language)] : [],
    );
    const held = [
      ...CLAUSES[template].flatMap((c) => [c.standard, c.fallback, c.unacceptable]),
      ...UNUSUAL[template].map((u) => u.text),
      ...BOILERPLATE.flatMap((b) => [b.text, b.edited]),
    ];
    const ours = new Set(held.flatMap((t) => [...shingles(t)]));
    expect(samples.filter((s) => ours.has(s))).toEqual([]);
  });
});

describe("generated contracts", () => {
  it("are the same bytes for the same seed", () => {
    const a = buildContract("msa", 3, 11, "x");
    const b = buildContract("msa", 3, 11, "x");
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.gold).toEqual(b.gold);
  });

  it("carry real tracked changes and the injected clauses where gold says", () => {
    for (const { bytes, gold } of generateCorpus(3, 4)) {
      const read = readDocx(bytes);
      for (const inj of gold.injected) {
        const p = read.paragraphs[inj.paragraph_index];
        if (inj.kind === "uncovered_clause") expect(p?.text).toBe(inj.text);
        else {
          // The paragraph now reads as the counterparty's edit, with both w:ins and w:del.
          expect(p?.text).toBe(inj.text);
          const kinds = read.existingEdits
            .filter((e) => e.paragraph_index === inj.paragraph_index)
            .map((e) => e.kind);
          expect(kinds).toEqual(expect.arrayContaining(["ins", "del"]));
        }
      }
      expect(gold.injected.some((i) => i.kind === "uncovered_clause")).toBe(true);
      expect(gold.injected.some((i) => i.kind === "existing_edit")).toBe(true);
      for (const r of gold.rules) {
        const text = CLAUSES[gold.template].find((c) => c.rule === r.rule);
        const present =
          r.variant !== "omitted" &&
          read.paragraphs.some((p) => text && p.text === text[r.variant as "standard"]);
        expect(present).toBe(r.variant !== "omitted");
      }
    }
  });

  it("reach about 40 pages for the longest target", () => {
    const { gold } = buildContract("nda", 40, 5, "long");
    expect(gold.pages).toBeGreaterThanOrEqual(40);
    expect(gold.pages).toBeLessThanOrEqual(42);
  });
});
