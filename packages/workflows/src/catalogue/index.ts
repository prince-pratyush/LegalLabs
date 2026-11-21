import { clientAlert } from "./client-alert.js";
import { courtOpinions } from "./court-opinions.js";
import { dealPoints } from "./deal-points.js";
import type { CatalogueEntry } from "./define.js";
import { diligenceInsights } from "./diligence-insights.js";
import { discovery } from "./discovery.js";
import { fromTemplate } from "./from-template.js";
import { interviewCalls } from "./interview-calls.js";
import { proofread } from "./proofread.js";
import { redlineChanges } from "./redlines.js";
import { requestList } from "./request-list.js";
import { researchMemo } from "./research-memo.js";
import { timeline } from "./timeline.js";
import { transcribe } from "./transcribe.js";
import { transcriptTopics } from "./transcript-topics.js";
import { translate } from "./translate.js";

export type { CatalogueEntry } from "./define.js";

/** The pre-built workflows (agents-workflows.md §4.11), in the order the spec lists them. */
export const CATALOGUE: readonly CatalogueEntry[] = [
  translate,
  proofread,
  clientAlert,
  timeline,
  fromTemplate,
  redlineChanges,
  researchMemo,
  transcriptTopics,
  discovery,
  diligenceInsights,
  interviewCalls,
  transcribe,
  requestList,
  dealPoints,
  courtOpinions,
];

export const catalogueEntry = (key: string) => CATALOGUE.find((e) => e.key === key);
