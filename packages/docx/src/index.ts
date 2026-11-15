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
export {
  type PatchEdit,
  PatchError,
  type PatchFailureCode,
  type PatchOptions,
  type PatchResult,
  paragraphFragment,
  patchDocx,
} from "./patch.js";
export {
  type BodyParagraph,
  type BodyRun,
  DocxError,
  type DocxErrorCode,
  type ExcludedKind,
  type ExistingEdit,
  type ReadResult,
  readDocx,
} from "./read.js";
export { buildTrackedDocx, type TrackedInput } from "./tracked.js";
