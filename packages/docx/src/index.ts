export { type ChangeSummary, type DiffOp, diffWords, summariseChanges } from "./diff.js";
export {
  buildDocx,
  buildTableDocx,
  citationFootnote,
  type DocxInput,
  type TableDocxInput,
} from "./docx.js";
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
  buildPdf,
  DEFAULT_LOOK,
  listLabel,
  type PageLook,
  type PdfInput,
  pageLook,
} from "./pdf.js";
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
export {
  CONTENT_MARK,
  openTemplate,
  placeholders,
  TemplateError,
  type TemplateProblem,
  TITLE_MARK,
} from "./template.js";
export { buildTrackedDocx, type TrackedInput } from "./tracked.js";
export { type OpenText, openText } from "./translate.js";
