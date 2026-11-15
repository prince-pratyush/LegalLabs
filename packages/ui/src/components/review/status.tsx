import type { FindingStatus, Gap, SuggestionStatus } from "@legallabs/contracts";
import { StatusText, type Tone } from "../status.js";
import { FINDING_LABEL, SEVERITY_LABEL, SUGGESTION_LABEL } from "./order.js";

const FINDING_TONE: Record<FindingStatus, Tone> = {
  acceptable: "verified",
  needs_review: "warning",
  not_acceptable: "failed",
  not_found: "flagged",
  skipped: "locked",
};

const SUGGESTION_TONE: Record<SuggestionStatus, Tone> = {
  pending: "running",
  applied: "verified",
  dismissed: "locked",
  superseded: "locked",
  anchor_failed: "flagged",
};

/** A rule's result as icon plus words. */
export function FindingStatusText({ status }: { status: FindingStatus }) {
  return <StatusText tone={FINDING_TONE[status]}>{FINDING_LABEL[status]}</StatusText>;
}

/** Where a suggested edit stands; pending reads as a plain suggestion, not a spinner. */
export function SuggestionStatusText({ status }: { status: SuggestionStatus }) {
  return (
    <StatusText tone={status === "pending" ? "external" : SUGGESTION_TONE[status]}>
      {SUGGESTION_LABEL[status]}
    </StatusText>
  );
}

export function GapSeverityText({ severity }: { severity: Gap["severity"] }) {
  const tone: Tone = severity === "high" ? "failed" : severity === "medium" ? "warning" : "locked";
  return <StatusText tone={tone}>{SEVERITY_LABEL[severity]} risk</StatusText>;
}
