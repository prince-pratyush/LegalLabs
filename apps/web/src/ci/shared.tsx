import type { CiAgentStatus, CiReviewStatus } from "@legallabs/contracts";
import { StatusText, type Tone } from "@legallabs/ui";

export const REVIEW_STATUS: Record<CiReviewStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "external" },
  running: { label: "Reviewing", tone: "running" },
  aligned: { label: "Aligned", tone: "verified" },
  needs_review: { label: "Needs review", tone: "warning" },
  deviates: { label: "Deviates", tone: "flagged" },
  done: { label: "Done", tone: "locked" },
  failed: { label: "Failed", tone: "failed" },
};

export const AGENT_STATUS: Record<CiAgentStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "external" },
  live: { label: "Live", tone: "verified" },
  paused: { label: "Paused", tone: "locked" },
};

export function ReviewStatusText({ status }: { status: CiReviewStatus }) {
  const { label, tone } = REVIEW_STATUS[status];
  return <StatusText tone={tone}>{label}</StatusText>;
}

export function AgentStatusText({ status }: { status: CiAgentStatus }) {
  const { label, tone } = AGENT_STATUS[status];
  return <StatusText tone={tone}>{label}</StatusText>;
}
