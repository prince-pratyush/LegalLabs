export { type ChangeSummary, type DiffOp, diffWords, summariseChanges } from "./diff.js";
export { buildDocx, citationFootnote, type DocxInput } from "./docx.js";
export {
  type Block,
  type BlockKind,
  blockText,
  type FootnoteRun,
  markdownBlocks,
  type Run,
  type TextRun,
} from "./markdown.js";
export { buildTrackedDocx, type TrackedInput } from "./tracked.js";
