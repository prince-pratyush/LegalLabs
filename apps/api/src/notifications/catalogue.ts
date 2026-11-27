import {
  type KindMeta,
  NOTIFICATION_KINDS,
  type NotificationAction,
  type NotificationKind,
} from "@legallabs/contracts";

/** Who an event concerns; each catalogue entry picks the roles it notifies. */
export interface NotificationPeople {
  owner?: string;
  runner?: string;
  recipients?: readonly string[];
  assignee?: string;
  creator?: string;
  requester?: string;
  mentioned?: readonly string[];
  approvers?: readonly string[];
  admins?: readonly string[];
  participants?: readonly string[];
  optedIn?: readonly string[];
}

/** What a module reports; the notifier turns it into notifications. */
export interface NotificationEvent {
  kind: NotificationKind;
  /** The person who did it, who never hears about their own action. Null for system events. */
  actorId: string | null;
  objectType: string;
  objectId: string;
  objectTitle: string;
  /** Checked against each recipient's walls when the notification is made. */
  matterId?: string | null;
  people: NotificationPeople;
  /** A comment or question; shown in the hub for those kinds, and in email only if allowed. */
  detail?: string;
  /** A run that took over a minute, which is emailed even in "action only" mode. */
  longRunning?: boolean;
  /** Overrides the link when the object isn't what the web app opens (a run opens its thread). */
  url?: string;
}

export interface CatalogueEntry extends KindMeta {
  recipients(event: NotificationEvent): string[];
  link(event: NotificationEvent): string;
  title(event: NotificationEvent): string;
  /** Whether the event's `detail` is kept as the in-app body. */
  body: boolean;
  /** No prompt, response or memory text, and no comment text unless the workspace allows it. */
  template: { subject(event: NotificationEvent): string; text(event: NotificationEvent): string };
  actions?: NotificationAction[];
}

const many = (...groups: (string | readonly string[] | undefined)[]): string[] =>
  groups.flatMap((g) => (g === undefined ? [] : typeof g === "string" ? [g] : [...g]));

const clip = (text: string, n: number) => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : chars.join("");
};
const name = (e: NotificationEvent) => clip(e.objectTitle, 120) || "Untitled";

const ROUTES: Record<string, (id: string) => string> = {
  thread: (id) => `#/t/${id}`,
  vault: (id) => `#/vaults/${id}`,
  table: (id) => `#/tables/${id}`,
  table_template: () => "#/tables/templates",
  playbook: (id) => `#/playbooks/${id}`,
  playbook_review: (id) => `#/reviews/${id}`,
  agent: (id) => `#/agents/${id}`,
  workflow: (id) => `#/workflows/${id}`,
  task: (id) => `#/tasks/${id}`,
  space: (id) => `#/spaces/${id}`,
  scan: (id) => `#/horizon/${id}`,
  knowledge_source: () => "#/admin/knowledge",
  admin: () => "#/admin",
  memory: () => "#/settings/memory",
};

/** The web app's route for an object, or its home page when the type is unknown. */
export const linkFor = (e: NotificationEvent) =>
  e.url ?? ROUTES[e.objectType]?.(encodeURIComponent(e.objectId)) ?? "#/";

interface Spec {
  recipients: (e: NotificationEvent) => string[];
  /** The headline, e.g. `Plan ready to approve: ${name}`. */
  title: (e: NotificationEvent) => string;
  /** One sentence for email; defaults to the headline. */
  sentence?: (e: NotificationEvent) => string;
  body?: boolean;
  actions?: NotificationAction[];
}

const primary = (id: string, label: string): NotificationAction => ({
  id,
  label,
  style: "primary",
});
const secondary = (id: string, label: string): NotificationAction => ({
  id,
  label,
  style: "secondary",
});
const danger = (id: string, label: string): NotificationAction => ({ id, label, style: "danger" });

const entry = (kind: NotificationKind, spec: Spec): CatalogueEntry => ({
  ...NOTIFICATION_KINDS[kind],
  recipients: spec.recipients,
  link: linkFor,
  title: (e) => clip(spec.title(e), 300),
  body: spec.body ?? false,
  template: {
    subject: (e) => clip(spec.title(e), 200),
    text: (e) => clip((spec.sentence ?? spec.title)(e), 300),
  },
  ...(spec.actions ? { actions: spec.actions } : {}),
});

const to = {
  owner: (e: NotificationEvent) => many(e.people.owner),
  runner: (e: NotificationEvent) => many(e.people.runner),
  recipients: (e: NotificationEvent) => many(e.people.recipients),
  assignee: (e: NotificationEvent) => many(e.people.assignee),
  requester: (e: NotificationEvent) => many(e.people.requester),
  mentioned: (e: NotificationEvent) => many(e.people.mentioned),
  approvers: (e: NotificationEvent) => many(e.people.approvers),
  admins: (e: NotificationEvent) => many(e.people.admins),
  optedIn: (e: NotificationEvent) => many(e.people.optedIn),
};

export const CATALOGUE: Record<NotificationKind, CatalogueEntry> = {
  "thread.run.completed": entry("thread.run.completed", {
    recipients: (e) => many(e.people.owner, e.people.runner),
    title: (e) => `Analysis finished: ${name(e)}`,
  }),
  "thread.run.needs_input": entry("thread.run.needs_input", {
    recipients: to.runner,
    title: (e) => `A question needs your answer: ${name(e)}`,
    body: true,
    actions: [primary("answer", "Answer question")],
  }),
  "thread.run.awaiting_approval": entry("thread.run.awaiting_approval", {
    recipients: to.runner,
    title: (e) => `Plan ready to approve: ${name(e)}`,
    actions: [primary("approve_plan", "Approve plan")],
  }),
  "thread.run.failed": entry("thread.run.failed", {
    recipients: to.runner,
    title: (e) => `Analysis failed: ${name(e)}`,
  }),
  "thread.shared": entry("thread.shared", {
    recipients: to.recipients,
    title: (e) => `A thread was shared with you: ${name(e)}`,
  }),
  "thread.mentioned": entry("thread.mentioned", {
    recipients: to.mentioned,
    title: (e) => `You were mentioned in ${name(e)}`,
    body: true,
  }),
  "vault.shared": entry("vault.shared", {
    recipients: to.recipients,
    title: (e) => `A vault was shared with you: ${name(e)}`,
  }),
  "vault.retention_warning": entry("vault.retention_warning", {
    recipients: (e) => many(e.people.owner, e.people.recipients),
    title: (e) => `Files in ${name(e)} will soon be moved to the bin`,
  }),
  "vault.sync_failed": entry("vault.sync_failed", {
    recipients: to.owner,
    title: (e) => `Sync failed for ${name(e)}`,
  }),
  "vault.organise_completed": entry("vault.organise_completed", {
    recipients: to.requester,
    title: (e) => `Organising finished: ${name(e)}`,
  }),
  "table.shared": entry("table.shared", {
    recipients: to.recipients,
    title: (e) => `A review table was shared with you: ${name(e)}`,
  }),
  "table.generation_completed": entry("table.generation_completed", {
    recipients: to.requester,
    title: (e) => `Review table ready: ${name(e)}`,
  }),
  "table.export_ready": entry("table.export_ready", {
    recipients: to.requester,
    title: (e) => `Your export is ready: ${name(e)}`,
  }),
  "table.sync_added_rows": entry("table.sync_added_rows", {
    recipients: to.optedIn,
    title: (e) => `New rows were added to ${name(e)}`,
  }),
  "table.template_approved": entry("table.template_approved", {
    recipients: to.requester,
    title: (e) => `Your review table template was approved: ${name(e)}`,
  }),
  "table.template_rejected": entry("table.template_rejected", {
    recipients: to.requester,
    title: (e) => `Your review table template was rejected: ${name(e)}`,
    body: true,
  }),
  "table.cell_assigned": entry("table.cell_assigned", {
    recipients: to.assignee,
    title: (e) => `A cell in ${name(e)} was assigned to you`,
    actions: [secondary("open", "Open table")],
  }),
  "table.cell_commented": entry("table.cell_commented", {
    recipients: to.assignee,
    title: (e) => `New comment in ${name(e)}`,
    body: true,
  }),
  "table.cell_mentioned": entry("table.cell_mentioned", {
    recipients: to.mentioned,
    title: (e) => `You were mentioned in ${name(e)}`,
    body: true,
  }),
  "playbook.review_completed": entry("playbook.review_completed", {
    recipients: to.runner,
    title: (e) => `Playbook review finished: ${name(e)}`,
  }),
  "ci.review_assigned": entry("ci.review_assigned", {
    recipients: to.assignee,
    title: (e) => `A contract is waiting for your review: ${name(e)}`,
    actions: [secondary("open", "Open review")],
  }),
  "playbook.assigned": entry("playbook.assigned", {
    recipients: to.assignee,
    title: (e) => `A playbook was assigned to you: ${name(e)}`,
    actions: [secondary("open", "Open playbook")],
  }),
  "agent.shared": entry("agent.shared", {
    recipients: to.recipients,
    title: (e) => `An agent was shared with you: ${name(e)}`,
  }),
  "workflow.shared": entry("workflow.shared", {
    recipients: to.recipients,
    title: (e) => `A workflow was shared with you: ${name(e)}`,
  }),
  "agent.share_requested": entry("agent.share_requested", {
    recipients: to.approvers,
    title: (e) => `Share request for the agent ${name(e)}`,
    actions: [primary("accept", "Accept"), danger("deny", "Deny")],
  }),
  "workflow.share_requested": entry("workflow.share_requested", {
    recipients: to.approvers,
    title: (e) => `Share request for the workflow ${name(e)}`,
    actions: [primary("accept", "Accept"), danger("deny", "Deny")],
  }),
  "agent.share_decided": entry("agent.share_decided", {
    recipients: to.requester,
    title: (e) => `Your share request for ${name(e)} was decided`,
  }),
  "workflow.share_decided": entry("workflow.share_decided", {
    recipients: to.requester,
    title: (e) => `Your share request for ${name(e)} was decided`,
  }),
  "agent.schedule_run_completed": entry("agent.schedule_run_completed", {
    recipients: to.owner,
    title: (e) => `Scheduled run finished: ${name(e)}`,
  }),
  "agent.schedule_run_failed": entry("agent.schedule_run_failed", {
    recipients: to.owner,
    title: (e) => `Scheduled run failed: ${name(e)}`,
  }),
  "task.assigned": entry("task.assigned", {
    recipients: to.assignee,
    title: (e) => `A task was assigned to you: ${name(e)}`,
    actions: [secondary("open", "Open task")],
  }),
  "task.status_changed": entry("task.status_changed", {
    recipients: (e) => many(e.people.assignee, e.people.creator),
    title: (e) => `Task status changed: ${name(e)}`,
  }),
  "task.commented": entry("task.commented", {
    recipients: (e) => many(e.people.participants),
    title: (e) => `New comment on ${name(e)}`,
    body: true,
  }),
  "task.mentioned": entry("task.mentioned", {
    recipients: to.mentioned,
    title: (e) => `You were mentioned on ${name(e)}`,
    body: true,
  }),
  "task.gate_pending": entry("task.gate_pending", {
    recipients: to.approvers,
    title: (e) => `Approval needed: ${name(e)}`,
    actions: [secondary("open", "Open task")],
  }),
  "task.due_soon": entry("task.due_soon", {
    recipients: to.assignee,
    title: (e) => `Due within 24 hours: ${name(e)}`,
    actions: [secondary("open", "Open task")],
  }),
  "space.invited": entry("space.invited", {
    recipients: to.recipients,
    title: (e) => `You were invited to the space ${name(e)}`,
  }),
  "space.request_access": entry("space.request_access", {
    recipients: to.admins,
    title: (e) => `Someone asked to join the space ${name(e)}`,
    actions: [secondary("open", "Open space")],
  }),
  "space.external_connection_pending": entry("space.external_connection_pending", {
    recipients: to.admins,
    title: (e) => `An external connection in ${name(e)} needs approval`,
    actions: [secondary("open", "Open space")],
  }),
  "horizon.digest": entry("horizon.digest", {
    recipients: to.recipients,
    title: (e) => `Horizon digest: ${name(e)}`,
  }),
  "horizon.scan_shared": entry("horizon.scan_shared", {
    recipients: to.recipients,
    title: (e) => `A Horizon scan was shared with you: ${name(e)}`,
  }),
  "knowledge.source.degraded": entry("knowledge.source.degraded", {
    recipients: to.admins,
    title: (e) => `A knowledge source needs attention: ${name(e)}`,
    actions: [secondary("open", "Open source")],
  }),
  "admin.retention_deletion_scheduled": entry("admin.retention_deletion_scheduled", {
    recipients: to.admins,
    title: (e) => `Deletion scheduled: ${name(e)}`,
  }),
  "memory.candidates_pending": entry("memory.candidates_pending", {
    recipients: to.owner,
    title: () => "You have memories waiting for review",
  }),
};
