// Writes sample documents for opening by hand in Word or LibreOffice.
// Usage: pnpm build && node scripts/samples.mjs <out-dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocx, buildTrackedDocx, citationFootnote, markdownBlocks } from "../dist/index.js";

const out = process.argv[2] ?? ".";
const date = "2026-11-14T03:00:00Z";
const before = `# Services Agreement

## 1. Payment

The Customer must pay each invoice within 30 days of receipt.

Late payments bear interest at 4% per year.

## 2. Liability

- The Supplier's liability is capped at **fees paid** in the prior 12 months.
- The cap does not apply to fraud.

This clause will be removed.`;
const after = `# Services Agreement

## 1. Payment Terms

The Customer must pay each undisputed invoice within 14 days of receipt.

Late payments bear interest at 4% per year.

## 2. Liability

- The Supplier's liability is capped at **fees paid** in the prior 24 months.
- The cap does not apply to fraud or wilful misconduct.
- A new carve-out for data breaches.

1. First numbered
2. Second numbered`;

writeFileSync(
  join(out, "tracked.docx"),
  buildTrackedDocx({ before, after, author: "LegalLabs", date, title: "Services Agreement" }),
);
const blocks = markdownBlocks(after);
blocks[2]?.runs.push({ footnote: 1 });
const note = citationFootnote({ document: "MSA.pdf", page: 14, quote: "within 14 days" });
writeFileSync(
  join(out, "plain.docx"),
  buildDocx({ title: "Memo", blocks, author: "LegalLabs", date, footnotes: [note] }),
);
console.log(`wrote tracked.docx and plain.docx to ${out}`);
