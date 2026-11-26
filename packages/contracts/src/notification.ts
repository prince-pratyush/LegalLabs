import { z } from "zod";

/** Groups of events, used for the in-app filter and the email toggles. */
export const NotificationCategory = z.enum([
  "threads",
  "vault",
  "review_tables",
  "playbooks",
  "agents",
  "tasks",
  "spaces",
  "horizon",
  "admin",
  "memory",
]);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

/** Memory roll-ups are in-app only, so email has no toggle for them. */
export const EmailCategory = NotificationCategory.exclude(["memory"]);
export type EmailCategory = z.infer<typeof EmailCategory>;

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  threads: "Threads",
  vault: "Vault",
  review_tables: "Review tables",
  playbooks: "Playbooks",
  agents: "Agents and workflows",
  tasks: "Tasks",
  spaces: "Spaces",
  horizon: "Horizon",
  admin: "Admin",
  memory: "Memory",
};

export interface KindMeta {
  category: NotificationCategory;
  /** The recipient must do something (approve, answer, review). */
  action_required: boolean;
  /** Shown in the hub; the horizon digest is email only. */
  in_app: boolean;
  /** May be emailed; the memory roll-up is in-app only. */
  email: boolean;
  /** Finishing a run; emailed in "action only" mode when the run took over a minute. */
  completion: boolean;
}

const meta = (
  category: NotificationCategory,
  action_required: boolean,
  extra: Partial<Pick<KindMeta, "in_app" | "email" | "completion">> = {},
): KindMeta => ({
  category,
  action_required,
  in_app: true,
  email: true,
  completion: false,
  ...extra,
});

/** The event catalogue's names and categories. Names are permanent: add, never rename. */
export const NOTIFICATION_KINDS = {
  "thread.run.completed": meta("threads", false, { completion: true }),
  "thread.run.needs_input": meta("threads", true),
  "thread.run.awaiting_approval": meta("threads", true),
  "thread.run.failed": meta("threads", false),
  "thread.shared": meta("threads", false),
  "thread.mentioned": meta("threads", false),
  "vault.shared": meta("vault", false),
  "vault.retention_warning": meta("vault", false),
  "vault.sync_failed": meta("vault", false),
  "vault.organise_completed": meta("vault", false, { completion: true }),
  "table.shared": meta("review_tables", false),
  "table.generation_completed": meta("review_tables", false, { completion: true }),
  "table.export_ready": meta("review_tables", false),
  "table.sync_added_rows": meta("review_tables", false),
  "table.template_approved": meta("review_tables", false),
  "table.template_rejected": meta("review_tables", false),
  "table.cell_assigned": meta("review_tables", true),
  "table.cell_commented": meta("review_tables", false),
  "table.cell_mentioned": meta("review_tables", false),
  "playbook.review_completed": meta("playbooks", false, { completion: true }),
  "playbook.assigned": meta("playbooks", true),
  "ci.review_assigned": meta("playbooks", true),
  "agent.shared": meta("agents", false),
  "workflow.shared": meta("agents", false),
  "agent.share_requested": meta("agents", true),
  "workflow.share_requested": meta("agents", true),
  "agent.share_decided": meta("agents", false),
  "workflow.share_decided": meta("agents", false),
  "agent.schedule_run_completed": meta("agents", false, { completion: true }),
  "agent.schedule_run_failed": meta("agents", false),
  "task.assigned": meta("tasks", true),
  "task.status_changed": meta("tasks", false),
  "task.commented": meta("tasks", false),
  "task.mentioned": meta("tasks", false),
  "task.gate_pending": meta("tasks", true),
  "task.due_soon": meta("tasks", true),
  "space.invited": meta("spaces", false),
  "space.request_access": meta("spaces", true),
  "space.external_connection_pending": meta("spaces", true),
  "horizon.digest": meta("horizon", false, { in_app: false }),
  "horizon.scan_shared": meta("horizon", false),
  "knowledge.source.degraded": meta("admin", true),
  "admin.retention_deletion_scheduled": meta("admin", false),
  "memory.candidates_pending": meta("memory", false, { email: false }),
} as const satisfies Record<string, KindMeta>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export const notificationKinds = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];
export const NotificationKindName = z.enum(
  notificationKinds as [NotificationKind, ...NotificationKind[]],
);

export const NOTIFICATION_LIMITS = {
  /** Same kind on the same object inside this window is one notification with a count. */
  dedupMinutes: 10,
  /** Unread (and read, unarchived) notifications are kept this long. */
  keepDays: 90,
  archivedKeepDays: 30,
  /** An item whose object is gone is archived after this long. */
  unavailableArchiveDays: 7,
  batchMinutes: 15,
  pageSize: 50,
  /** Email shows at most this much of a comment or question, when the workspace allows it. */
  emailExcerpt: 300,
} as const;

/**
 * An in-app link: a hash route (`#/t/123`) or a same-origin path (`/d/123`). Schemes
 * (`javascript:`, `data:`, `https:`), protocol-relative `//host` and backslashes are refused,
 * so a notification can never carry a link that leaves the app.
 */
export const RELATIVE_LINK = /^(#\/|\/(?![/\\]))[^\s\\]*$/;
export const isRelativeLink = (url: string) => url.length <= 2000 && RELATIVE_LINK.test(url);
export const RelativeLink = z.string().max(2000).regex(RELATIVE_LINK, "must be a relative link");

/** Where an item whose object is gone points; the web app shows a plain "no longer available" page. */
export const UNAVAILABLE_LINK = "#/unavailable";

export const NotificationAction = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  style: z.enum(["primary", "secondary", "danger"]),
});
export type NotificationAction = z.infer<typeof NotificationAction>;

export const Notification = z.object({
  id: z.uuid(),
  kind: z.string(),
  category: NotificationCategory,
  object_type: z.string(),
  object_id: z.uuid(),
  title: z.string(),
  body: z.string().optional(),
  actor: z.object({ id: z.uuid(), name: z.string() }).optional(),
  action_required: z.boolean(),
  actions: z.array(NotificationAction).optional(),
  url: RelativeLink,
  created_at: z.string(),
  read_at: z.string().optional(),
  archived_at: z.string().optional(),
  /** Set once an inline action has been taken, so the hub shows "Done". */
  done_at: z.string().optional(),
  count: z.number().int().min(1),
  available: z.boolean(),
});
export type Notification = z.infer<typeof Notification>;

export const NotificationCounts = z.object({
  unread: z.number().int().min(0),
  action_required: z.number().int().min(0),
});
export type NotificationCounts = z.infer<typeof NotificationCounts>;

export const NotificationTab = z.enum(["all", "action_required"]);
export const NotificationState = z.enum(["unread_read", "unread", "archived"]);

export const NotificationQuery = z.object({
  tab: NotificationTab.default("all"),
  state: NotificationState.default("unread_read"),
  category: NotificationCategory.optional(),
  cursor: z.string().max(200).optional(),
});
export type NotificationQuery = z.infer<typeof NotificationQuery>;

export const NotificationPatch = z
  .object({ read: z.boolean().optional(), archived: z.boolean().optional() })
  .strict()
  .refine((p) => p.read !== undefined || p.archived !== undefined, "nothing to change");
export type NotificationPatch = z.infer<typeof NotificationPatch>;

export const NotificationActBody = z
  .object({
    action: z.string().min(1).max(40),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type NotificationActBody = z.infer<typeof NotificationActBody>;

export const NotificationActResult = z.object({
  result: z.enum(["done", "redirect"]),
  url: RelativeLink.optional(),
});
export type NotificationActResult = z.infer<typeof NotificationActResult>;

/** Email for action-required events and long completions, or for every event of a category. */
export const EmailMode = z.enum(["action_only", "all"]);
export type EmailMode = z.infer<typeof EmailMode>;

const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const QuietHours = z.object({
  from: LocalTime,
  to: LocalTime,
  /** An IANA zone such as `Australia/Sydney`; checked where it is used. */
  tz: z.string().min(1).max(64),
});
export type QuietHours = z.infer<typeof QuietHours>;

export const CategorySetting = z.object({
  category: EmailCategory,
  user_value: z.boolean().optional(),
  workspace_default: z.boolean(),
  locked: z.boolean(),
  effective: z.boolean(),
  mode: EmailMode,
});
export type CategorySetting = z.infer<typeof CategorySetting>;

export const NotificationSettings = z.object({
  categories: z.array(CategorySetting),
  quiet_hours: QuietHours.optional(),
  include_content: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const NotificationSettingsPatch = z
  .object({
    categories: z
      .array(z.object({ category: EmailCategory, value: z.boolean(), mode: EmailMode.optional() }))
      .max(20)
      .optional(),
    /** Null clears them. */
    quiet_hours: QuietHours.nullable().optional(),
  })
  .strict();
export type NotificationSettingsPatch = z.infer<typeof NotificationSettingsPatch>;

export const AdminNotificationSettings = z.object({
  categories: z.array(
    z.object({ category: EmailCategory, default: z.boolean(), locked: z.boolean() }),
  ),
  include_content: z.boolean(),
});
export type AdminNotificationSettings = z.infer<typeof AdminNotificationSettings>;

export const AdminNotificationSettingsPatch = z
  .object({
    categories: z
      .array(
        z.object({
          category: EmailCategory,
          default: z.boolean().optional(),
          locked: z.boolean().optional(),
        }),
      )
      .max(20)
      .optional(),
    include_content: z.boolean().optional(),
  })
  .strict();
export type AdminNotificationSettingsPatch = z.infer<typeof AdminNotificationSettingsPatch>;
