import type { IntakeChannel, IntakeSlaState, IntakeStatus } from "@legallabs/contracts";
import { StatusText, type Tone } from "@legallabs/ui";

export const STATUS: Record<IntakeStatus, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "external" },
  unclassified: { label: "Unclassified", tone: "warning" },
  awaiting_requester: { label: "Awaiting requester", tone: "external" },
  triaged: { label: "Triaged", tone: "running" },
  in_progress: { label: "In progress", tone: "running" },
  waiting_approval: { label: "Waiting for approval", tone: "warning" },
  done: { label: "Done", tone: "verified" },
  closed: { label: "Closed", tone: "locked" },
};

export const SLA: Record<IntakeSlaState, { label: string; tone: Tone }> = {
  ok: { label: "On time", tone: "verified" },
  at_risk: { label: "At risk", tone: "warning" },
  breached: { label: "Breached", tone: "failed" },
};

export const CHANNEL: Record<IntakeChannel, string> = {
  email: "Email",
  slack: "Slack",
  teams: "Teams",
  jira: "Jira",
  servicenow: "ServiceNow",
  gmail: "Gmail",
  dms: "Document system",
  api: "Manual",
};

export function RequestStatusText({ status }: { status: IntakeStatus }) {
  const { label, tone } = STATUS[status];
  return <StatusText tone={tone}>{label}</StatusText>;
}

export function SlaText({ state }: { state: IntakeSlaState }) {
  const { label, tone } = SLA[state];
  return <StatusText tone={tone}>{label}</StatusText>;
}

/** How long ago, in the largest whole unit. */
export function age(since: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}
