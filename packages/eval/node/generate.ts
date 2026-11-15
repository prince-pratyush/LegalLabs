// Writes the playbook-review corpus: synthetic NDA and MSA .docx files with gold labels.
// Usage: node node/generate.ts --out <dir> [--seed 7] [--count 16]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { estimatePages, PLAYBOOK_LIMITS } from "@legallabs/contracts";
import { type Block, buildDocx, patchDocx, readDocx } from "@legallabs/docx";
import {
  BOILERPLATE,
  CLAUSES,
  GOLD,
  PARTIES,
  type Status,
  type Template,
  UNUSUAL,
  type Variant,
} from "./clauses.ts";

// Bump when generated text or labels change, so old runs are never scored against new gold.
export const GENERATOR_VERSION = 2;
export const DEFAULT_SEED = 7;
export const DEFAULT_COUNT = 16;
/** Page targets, shortest first, so a run with --limit takes the quick contracts. */
const PAGE_TARGETS = [3, 5, 8, 12, 18, 25, 40, 40];
const AUTHOR = "Corvane Legal";
const DATE = "2026-10-01T09:00:00Z";
const VARIANTS: Variant[] = ["standard", "fallback", "unacceptable", "omitted"];

export type RuleGold = { rule: string; variant: Variant; status: Status };
export type Injected = {
  key: string;
  kind: "uncovered_clause" | "existing_edit";
  paragraph_index: number;
  text: string;
};
export type ContractGold = {
  id: string;
  template: Template;
  file: string;
  pages_target: number;
  chars: number;
  pages: number;
  rules: RuleGold[];
  injected: Injected[];
};
export type Corpus = { generator_version: number; seed: number; contracts: ContractGold[] };

/** mulberry32: small, seedable and the same on every platform. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const sample = <T>(items: readonly T[], n: number): T[] => {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(int(pool.length), 1)[0] as T);
    return out;
  };
  return { next, int, pick, sample };
}
type Rng = ReturnType<typeof rng>;

const names = (template: Template) =>
  template === "msa"
    ? { us: "the Customer", them: "the Supplier" }
    : { us: "Ardent", them: "Corvane" };

const fill = (text: string, template: Template) => {
  const n = names(template);
  const out = text.replaceAll("{us}", n.us).replaceAll("{them}", n.them);
  return out.charAt(0).toUpperCase() + out.slice(1);
};

const para = (text: string): Block => ({ kind: "paragraph", runs: [{ text }] });
const heading = (text: string, level: 1 | 2 | 3 = 2): Block => ({
  kind: `heading${level}`,
  runs: [{ text }],
});

// Operational schedule text: descriptive only, so it adds length without adding terms.
const SITES = ["Parramatta", "Newcastle", "Geelong", "Townsville", "Hobart", "Ballarat", "Darwin"];
const RECORDS = [
  "inventory ledger",
  "dispatch register",
  "customer contact list",
  "asset register",
  "rostering file",
  "maintenance log",
  "product catalogue",
];
const TEAMS = ["regional operations", "finance", "quality", "logistics", "service desk", "audit"];
const STEPS = [
  "checked against the previous month",
  "reconciled with the source system",
  "summarised in a one-page note",
  "reviewed by a team lead",
  "archived in the shared drive",
  "tagged with the reporting period",
];

function scheduleItem(r: Rng, n: number, template: Template): string {
  const site = r.pick(SITES);
  const record = r.pick(RECORDS);
  const [a, b] = r.sample(STEPS, 2);
  const team = r.pick(TEAMS);
  const lead =
    template === "msa"
      ? `Item ${n}. The weekly ${record} extract for the ${site} site`
      : `Item ${n}. Information from the ${record} for the ${site} site`;
  return `${lead} is prepared from the current records, ${a}, ${b}, and passed to the ${team} team. The extract covers ${2 + r.int(9)} fields, is produced in ${r.pick(["CSV", "PDF", "spreadsheet"])} form and is usually about ${10 + r.int(90)} pages long.`;
}

type Section = { heading: string; text: string; inject?: Omit<Injected, "paragraph_index"> };

function contractBlocks(
  template: Template,
  r: Rng,
  pagesTarget: number,
): { blocks: Block[]; rules: RuleGold[]; sections: Section[]; edited: Set<string> } {
  const specs = CLAUSES[template];
  const rules: RuleGold[] = specs.map((spec) => {
    const variant = r.pick(VARIANTS);
    return { rule: spec.rule, variant, status: GOLD[variant] };
  });
  const sections: Section[] = [];
  specs.forEach((spec, i) => {
    const variant = rules[i]?.variant ?? "omitted";
    if (variant !== "omitted") sections.push({ heading: spec.heading, text: spec[variant] });
  });
  // One or two unusual clauses, each placed somewhere among the operative clauses.
  for (const u of r.sample(UNUSUAL[template], 1 + r.int(2))) {
    const at = r.int(sections.length + 1);
    sections.splice(at, 0, {
      heading: u.heading,
      text: u.text,
      inject: { key: u.key, kind: "uncovered_clause", text: u.text },
    });
  }
  const edited = new Set(r.sample(BOILERPLATE, 1 + r.int(2)).map((b) => b.key));
  for (const b of BOILERPLATE)
    sections.push({
      heading: b.heading,
      text: fill(b.text, template),
      ...(edited.has(b.key)
        ? {
            inject: {
              key: b.key,
              kind: "existing_edit" as const,
              text: fill(b.edited, template),
            },
          }
        : {}),
    });

  const msa = template === "msa";
  const blocks: Block[] = [
    heading(msa ? "Master Services Agreement" : "Mutual Non-Disclosure Agreement", 1),
    para(
      msa
        ? `This agreement is made between ${PARTIES.us} of Sydney (the Customer) and ${PARTIES.them} of Melbourne (the Supplier). Every party and fact in it is fictional.`
        : `This agreement is made between ${PARTIES.us} of Sydney (Ardent) and ${PARTIES.them} of Melbourne (Corvane). Every party and fact in it is fictional.`,
    ),
    heading("1. Definitions"),
    para(
      msa
        ? "Services means the services described in Schedule 1. Fees means the charges set out in Schedule 2. Customer data means all data the Customer or its users provide or the services generate for it."
        : "Purpose means evaluating a possible collaboration on warehouse analytics. Discloser means the party disclosing information, and Recipient means the party receiving it.",
    ),
  ];
  sections.forEach((s, i) => {
    blocks.push(heading(`${i + 2}. ${s.heading}`), para(s.text));
  });

  const target = pagesTarget * PLAYBOOK_LIMITS.chars_per_page;
  let chars = blocks.reduce(
    (sum, b) => sum + b.runs.map((x) => ("text" in x ? x.text : "")).join("").length,
    0,
  );
  let schedule = 0;
  let item = 0;
  while (chars < target) {
    if (item % 40 === 0) {
      schedule++;
      const title = `Schedule ${schedule}. ${msa ? "Service description" : "Information categories"}, part ${schedule}`;
      blocks.push(heading(title));
      chars += title.length;
    }
    item++;
    const text = scheduleItem(r, item, template);
    blocks.push(para(text));
    chars += text.length;
  }
  return { blocks, rules, sections, edited };
}

/** Builds one contract; the same template, target and seed always give the same bytes. */
export function buildContract(
  template: Template,
  pagesTarget: number,
  seed: number,
  id: string,
): { bytes: Uint8Array; gold: ContractGold } {
  const r = rng(seed);
  const { blocks, rules, sections } = contractBlocks(template, r, pagesTarget);
  const base = buildDocx({
    title: template === "msa" ? "Master Services Agreement" : "Mutual Non-Disclosure Agreement",
    blocks,
    author: AUTHOR,
    date: DATE,
  });
  const read = readDocx(base);
  const indexOf = (text: string) => {
    const hits = read.paragraphs.filter((p) => p.text === text);
    if (hits.length !== 1) throw new Error(`${id}: expected one paragraph for "${text}"`);
    return (hits[0] as (typeof hits)[number]).index;
  };
  const injected: Injected[] = [];
  const edits = [];
  for (const s of sections) {
    if (!s.inject) continue;
    const paragraph_index = indexOf(s.text);
    injected.push({ ...s.inject, paragraph_index });
    if (s.inject.kind === "existing_edit")
      edits.push({
        id: s.inject.key,
        kind: "replace" as const,
        paragraph_index,
        before: s.text,
        after: s.inject.text,
      });
  }
  // The counterparty's own redline, so the review meets real w:ins/w:del runs.
  const patched = edits.length ? patchDocx(base, edits, { author: AUTHOR, date: DATE }) : null;
  if (patched?.failed.length)
    throw new Error(`${id}: could not track ${patched.failed.map((f) => f.id).join(", ")}`);
  const bytes = patched ? patched.bytes : base;
  const final = readDocx(bytes);
  for (const e of edits)
    if (!final.existingEdits.some((x) => x.paragraph_index === e.paragraph_index))
      throw new Error(`${id}: tracked change in paragraph ${e.paragraph_index} was not read back`);
  return {
    bytes,
    gold: {
      id,
      template,
      file: `${id}.docx`,
      pages_target: pagesTarget,
      chars: final.charCount,
      pages: estimatePages(final.charCount),
      rules,
      injected,
    },
  };
}

export function generateCorpus(seed: number, count: number) {
  if (!(Number.isInteger(count) && count >= 1 && count <= 200))
    throw new RangeError(`count must be 1 to 200, not ${count}`);
  const out: { bytes: Uint8Array; gold: ContractGold }[] = [];
  for (let i = 0; i < count; i++) {
    const template: Template = i % 2 === 0 ? "nda" : "msa";
    const pages = PAGE_TARGETS[Math.floor(i / 2) % PAGE_TARGETS.length] ?? 5;
    const id = `${template}-${String(i + 1).padStart(3, "0")}-p${String(pages).padStart(2, "0")}`;
    out.push(buildContract(template, pages, seed * 1000 + i, id));
  }
  return out;
}

export function writeCorpus(dir: string, seed: number, count: number): Corpus {
  mkdirSync(dir, { recursive: true });
  const contracts = generateCorpus(seed, count);
  for (const c of contracts) writeFileSync(join(dir, c.gold.file), c.bytes);
  const corpus: Corpus = {
    generator_version: GENERATOR_VERSION,
    seed,
    contracts: contracts.map((c) => c.gold),
  };
  writeFileSync(join(dir, "gold.json"), `${JSON.stringify(corpus, null, 2)}\n`);
  return corpus;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      seed: { type: "string", default: String(DEFAULT_SEED) },
      count: { type: "string", default: String(DEFAULT_COUNT) },
    },
  });
  if (!values.out) {
    console.error("usage: node node/generate.ts --out <dir> [--seed 7] [--count 16]");
    process.exit(2);
  }
  const corpus = writeCorpus(values.out, Number(values.seed), Number(values.count));
  const pages = corpus.contracts.reduce((s, c) => s + c.pages, 0);
  console.log(`wrote ${corpus.contracts.length} contracts (${pages} pages) to ${values.out}`);
}
