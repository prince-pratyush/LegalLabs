import {
  type Assignee,
  type Caller,
  FINISHED,
  renderSpaceContext,
  SPACE_LIMITS,
  type SpaceContext,
  type TaskCreate,
  type TaskOutput,
  type TaskPatch,
  type TaskRunPort,
  type TaskStatus,
} from "@legallabs/contracts";
import type { Client, Principal } from "../auth/auth.js";
import {
  type Db,
  isId,
  type Kit,
  matterDisplay,
  needAdmin,
  needMember,
  one,
  type ResourceCatalog,
  type Result,
  refusal,
  roleOf,
} from "./kit.js";

export interface PhaseView {
  id: string;
  ordinal: number;
  name: string;
  locked: boolean;
  /** Gate tasks still to approve in this phase. */
  gatePending: number;
}

export interface TaskView {
  id: string;
  spaceId: string;
  phaseId: string | null;
  name: string;
  descriptionMd: string;
  assignee: Assignee | null;
  createdBy: string;
  dueAt: string | null;
  status: TaskStatus;
  awaitingApproval: boolean;
  locked: boolean;
  gate: boolean;
  linked: {
    resources: { resource_type: string; resource_id: string }[];
    outputs: TaskOutput[];
  };
  run: { id: string; status: string; threadId: string | null } | null;
  approvedBy: string | null;
  approvedAt: string | null;
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommentView {
  id: string;
  taskId: string;
  authorType: "user" | "assistant";
  authorId: string | null;
  authorName: string | null;
  /** Null once deleted: a tombstone keeps the place in the thread. */
  bodyMd: string | null;
  mentions: string[];
  editedAt: string | null;
  deleted: boolean;
  createdAt: string;
}

export interface Tasks {
  phases(p: Principal, spaceId: string): Promise<PhaseView[] | null>;
  createPhase(
    p: Principal,
    spaceId: string,
    input: { name: string; after_phase_id?: string | undefined },
    client: Client,
  ): Promise<Result<PhaseView>>;
  patchPhase(
    p: Principal,
    spaceId: string,
    phaseId: string,
    patch: { name?: string | undefined; ordinal?: number | undefined },
    client: Client,
  ): Promise<Result<PhaseView[]>>;
  removePhase(
    p: Principal,
    spaceId: string,
    phaseId: string,
    client: Client,
  ): Promise<Result<null>>;
  unlockPhase(
    p: Principal,
    spaceId: string,
    phaseId: string,
    client: Client,
  ): Promise<Result<PhaseView>>;

  list(
    p: Principal,
    spaceId: string,
    q: { assignee?: "me"; status?: TaskStatus; phaseId?: string },
  ): Promise<TaskView[] | null>;
  get(p: Principal, taskId: string): Promise<TaskView | null>;
  create(
    p: Principal,
    spaceId: string,
    input: TaskCreate,
    client: Client,
  ): Promise<Result<TaskView>>;
  patch(p: Principal, taskId: string, patch: TaskPatch, client: Client): Promise<Result<TaskView>>;
  approve(p: Principal, taskId: string, client: Client): Promise<Result<TaskView>>;
  reject(p: Principal, taskId: string, comment: string, client: Client): Promise<Result<TaskView>>;
  /** Answers the question a run is waiting on. */
  answer(p: Principal, taskId: string, answer: string, client: Client): Promise<Result<TaskView>>;
  /** The run engine calls this, as the run's owner, when a run ends. */
  runFinished(caller: Caller, runId: string, client: Client): Promise<Result<TaskView | null>>;

  comments(p: Principal, taskId: string): Promise<CommentView[] | null>;
  addComment(
    p: Principal,
    taskId: string,
    input: { body_md: string; mentions?: string[] | undefined },
    client: Client,
  ): Promise<Result<CommentView>>;
  editComment(
    p: Principal,
    taskId: string,
    commentId: string,
    bodyMd: string,
    client: Client,
  ): Promise<Result<CommentView>>;
  removeComment(
    p: Principal,
    taskId: string,
    commentId: string,
    client: Client,
  ): Promise<Result<null>>;

  exportCsv(p: Principal, spaceId: string, client: Client): Promise<Result<string>>;
}

interface TaskRow {
  id: string;
  space_id: string;
  phase_id: string | null;
  name: string;
  description_md: string;
  assignee_type: "user" | "assistant" | "agent" | null;
  assignee_id: string | null;
  created_by: string;
  due: string | null;
  status: TaskStatus;
  awaiting_approval: boolean;
  gate: boolean;
  linked: TaskView["linked"];
  run_id: string | null;
  run_status: string | null;
  thread_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  locked: boolean;
  comments: number;
}

const TASK_SQL = `
  select t.id, t.space_id, t.phase_id, t.name, t.description_md, t.assignee_type, t.assignee_id,
         t.created_by, to_char(t.due_at, 'YYYY-MM-DD') as due, t.status, t.awaiting_approval, t.gate,
         t.linked, t.run_id, t.run_status, t.thread_id, t.approved_by, t.approved_at,
         t.created_at, t.updated_at,
         (t.phase_id is not null and work.phase_locked(t.phase_id)) as locked,
         (select count(*) from work.task_comment c
           where c.task_id = t.id and c.deleted_at is null)::int as comments
    from work.task t`;

const assigneeOf = (r: TaskRow): Assignee | null => {
  if (r.assignee_type === "user" && r.assignee_id) return { type: "user", user_id: r.assignee_id };
  if (r.assignee_type === "agent" && r.assignee_id) {
    return { type: "agent", agent_id: r.assignee_id };
  }
  return r.assignee_type === "assistant" ? { type: "assistant" } : null;
};

const taskView = (r: TaskRow): TaskView => ({
  id: r.id,
  spaceId: r.space_id,
  phaseId: r.phase_id,
  name: r.name,
  descriptionMd: r.description_md,
  assignee: assigneeOf(r),
  createdBy: r.created_by,
  dueAt: r.due,
  status: r.status,
  awaitingApproval: r.awaiting_approval,
  locked: r.locked,
  gate: r.gate,
  linked: r.linked,
  run: r.run_id ? { id: r.run_id, status: r.run_status ?? "planned", threadId: r.thread_id } : null,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at?.toISOString() ?? null,
  commentsCount: r.comments,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const finished = (status: string | null) =>
  status !== null && (FINISHED as readonly string[]).includes(status);

/** A task with a run that is still going, held by the assistant or an agent. */
const live = (r: TaskRow) =>
  r.run_id !== null &&
  (r.assignee_type === "agent" || r.assignee_type === "assistant") &&
  !finished(r.run_status);

interface CommentRow {
  id: string;
  task_id: string;
  author_type: "user" | "assistant";
  author_id: string | null;
  author_name: string | null;
  body_md: string;
  mentions: string[];
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

const COMMENT_SQL = `
  select c.id, c.task_id, c.author_type, c.author_id,
         coalesce(nullif(u.name, ''), u.email) as author_name,
         c.body_md, c.mentions, c.edited_at, c.deleted_at, c.created_at
    from work.task_comment c left join core."user" u on u.id = c.author_id`;

const commentView = (r: CommentRow): CommentView => ({
  id: r.id,
  taskId: r.task_id,
  authorType: r.author_type,
  authorId: r.author_id,
  authorName: r.author_name,
  bodyMd: r.deleted_at ? null : r.body_md,
  mentions: r.mentions,
  editedAt: r.edited_at?.toISOString() ?? null,
  deleted: r.deleted_at !== null,
  createdAt: r.created_at.toISOString(),
});

interface PhaseRow {
  id: string;
  ordinal: number;
  name: string;
  locked: boolean;
  gate_pending: number;
}

const PHASE_SQL = `
  select ph.id, ph.ordinal, ph.name, work.phase_locked(ph.id) as locked,
         (select count(*) from work.task t
           where t.phase_id = ph.id and t.gate and t.status <> 'cancelled'
             and t.approved_at is null)::int as gate_pending
    from work.phase ph`;

const phaseView = (r: PhaseRow): PhaseView => ({
  id: r.id,
  ordinal: r.ordinal,
  name: r.name,
  locked: r.locked,
  gatePending: r.gate_pending,
});

/** Spreadsheets run text beginning with these as a formula, so such cells are neutralised. */
const csvCell = (value: string | null) => {
  const text = value ?? "";
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const NO_CLIENT: Client = { ip: null, userAgent: null };

export interface TasksOptions {
  runs: TaskRunPort;
  now?: () => number;
}

export function createTasks(kit: Kit, catalog: ResourceCatalog, options: TasksOptions): Tasks {
  const { runs } = options;
  const now = options.now ?? Date.now;
  const callerOf = (p: Principal): Caller => ({ workspaceId: p.workspaceId, userId: p.userId });

  const loadTask = async (db: Db, id: string, lock = false) => {
    const row = isId(id)
      ? await one<TaskRow>(db, `${TASK_SQL} where t.id = $1${lock ? " for update of t" : ""}`, [id])
      : null;
    if (!row) throw refusal("NOT_FOUND");
    return row;
  };
  const viewOf = async (db: Db, id: string) => taskView(await loadTask(db, id));

  const phaseViews = async (db: Db, spaceId: string) =>
    (
      await db.query<PhaseRow>(`${PHASE_SQL} where ph.space_id = $1 order by ph.ordinal`, [spaceId])
    ).rows.map(phaseView);
  const phaseOf = async (db: Db, spaceId: string, phaseId: string) => {
    const row = isId(phaseId)
      ? await one<PhaseRow>(db, `${PHASE_SQL} where ph.id = $1 and ph.space_id = $2`, [
          phaseId,
          spaceId,
        ])
      : null;
    if (!row) throw refusal("NOT_FOUND");
    return phaseView(row);
  };

  /** Renumbers a Space's phases 1..n in the given order; the unique index is deferred. */
  const renumber = async (db: Db, ids: string[]) => {
    await db.query(
      `update work.phase p set ordinal = v.n
         from unnest($1::uuid[]) with ordinality as v(id, n) where p.id = v.id`,
      [ids],
    );
  };
  const orderOf = async (db: Db, spaceId: string) =>
    (
      await db.query<{ id: string }>(
        "select id from work.phase where space_id = $1 order by ordinal",
        [spaceId],
      )
    ).rows.map((r) => r.id);

  const validAssignee = async (db: Db, spaceId: string, assignee: Assignee) => {
    if (assignee.type === "user") {
      const ok = await one<{ ok: boolean }>(db, "select work.user_in_space($1, $2) as ok", [
        spaceId,
        assignee.user_id,
      ]);
      if (!ok?.ok) throw refusal("INVALID_ASSIGNEE");
    }
    if (assignee.type === "agent") {
      // Shared into the Space at Run or above, and the assigner holds Run on it too.
      const shared = await one<{ ok: boolean }>(
        db,
        `select (core.level_rank(r.access) >= core.level_rank('run')
                 and core.has_access('agent', r.resource_id, 'run')) as ok
           from work.space_resource r
          where r.space_id = $1 and r.resource_type = 'agent' and r.resource_id = $2
            and r.suspended_reason is null`,
        [spaceId, assignee.agent_id],
      );
      if (!shared?.ok) throw refusal("AGENT_NOT_SHARED");
    }
  };

  const assigneeColumns = (a: Assignee | null) =>
    [
      a?.type ?? null,
      a?.type === "user" ? a.user_id : a?.type === "agent" ? a.agent_id : null,
    ] as const;

  /** Notes when approving a gate opened the next phase. */
  const noteUnlocked = async (db: Db, p: Principal, task: TaskRow) => {
    if (!task.phase_id) return;
    const next = await one<{ id: string; locked: boolean }>(
      db,
      `select n.id, work.phase_locked(n.id) as locked
         from work.phase c join work.phase n on n.space_id = c.space_id and n.ordinal = c.ordinal + 1
        where c.id = $1`,
      [task.phase_id],
    );
    if (next && !next.locked) {
      await kit.activity(db, p, task.space_id, "phase.unlocked", { type: "phase", id: next.id });
    }
  };

  /** The prompt a run for this task starts from: the Space Context, then the task. */
  const promptFor = async (db: Db, task: TaskRow) => {
    const space = await one<{
      name: string;
      context: SpaceContext;
      client_id: string | null;
      client_name: string | null;
      matter_number: string | null;
    }>(
      db,
      `select s.name, s.context, m.client_id, m.client_name, m.matter_number
         from work.space s left join core.matter m on m.id = s.matter_id where s.id = $1`,
      [task.space_id],
    );
    const context = space
      ? renderSpaceContext({
          name: space.name,
          matterDisplay:
            space.client_id && space.client_name && space.matter_number
              ? matterDisplay({
                  client_id: space.client_id,
                  client_name: space.client_name,
                  matter_number: space.matter_number,
                })
              : null,
          context: space.context,
        })
      : "";
    const linked: string[] = [];
    for (const r of task.linked.resources) {
      const lookup = catalog[r.resource_type as keyof ResourceCatalog];
      const found = lookup ? await lookup(db, r.resource_id) : null;
      if (found) linked.push(`- ${r.resource_type}: ${found.name} (${r.resource_id})`);
    }
    return [
      context,
      `Task: ${task.name}`,
      task.description_md,
      linked.length ? `Linked resources:\n${linked.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  /**
   * Starts the run for a task assigned to the assistant or an agent. The engine is called between
   * two short transactions, never inside one, so a slow start holds no locks. If it can't start,
   * the task goes back to unassigned and the caller hears so.
   */
  async function startRun(p: Principal, taskId: string, client: Client): Promise<Result<TaskView>> {
    const prepared = await kit.attempt(p, async (db) => {
      const task = await loadTask(db, taskId);
      const space = await one<{ interactive: boolean }>(
        db,
        `select coalesce((customization ->> 'agent_runs_interactive')::boolean, true) as interactive
           from work.space where id = $1`,
        [task.space_id],
      );
      return { task, prompt: await promptFor(db, task), interactive: space?.interactive ?? true };
    });
    if (!prepared.ok) return prepared;
    const { task, prompt, interactive } = prepared.value;
    const assignee = assigneeOf(task);
    if (!assignee || assignee.type === "user") return kit.attempt(p, (db) => viewOf(db, taskId));

    let started: { runId: string; threadId: string } | null = null;
    try {
      started = await runs.start(callerOf(p), {
        taskId,
        spaceId: task.space_id,
        assignee:
          assignee.type === "agent"
            ? { type: "agent", agentId: assignee.agent_id }
            : { type: "assistant" },
        prompt,
        interactive,
      });
    } catch {
      started = null;
    }
    if (!started) {
      // Committed on its own: a refusal inside the transaction would roll the unassign back.
      await kit.attempt(p, (db) =>
        db.query("update work.task set assignee_type = null, assignee_id = null where id = $1", [
          taskId,
        ]),
      );
      return { ok: false, reason: "RUN_START_FAILED" };
    }
    const run = started;
    return kit.attempt(p, async (db) => {
      await db.query(
        `update work.task
            set run_id = $2, thread_id = $3, run_status = 'running', status = 'in_progress'
          where id = $1`,
        [taskId, run.runId, run.threadId],
      );
      await kit.audit(db, p, client, "task.assigned", "task", taskId, {
        assignee_type: assignee.type,
        run_id: run.runId,
      });
      await kit.activity(
        db,
        p,
        task.space_id,
        "task.assigned",
        { type: "task", id: taskId },
        { assignee_type: assignee.type },
      );
      return viewOf(db, taskId);
    });
  }

  /** Reads a run's state and, when it has ended, hands the task back to whoever made it. */
  async function sync(p: Principal, taskId: string, client: Client): Promise<void> {
    const before = await kit.attempt(p, (db) => loadTask(db, taskId));
    if (!before.ok || !live(before.value) || !before.value.run_id) return;
    const runId = before.value.run_id;
    let state: Awaited<ReturnType<TaskRunPort["status"]>>;
    try {
      state = await runs.status(callerOf(p), runId);
    } catch {
      // The engine is unreachable: the task stays as it was and is read again next time.
      return;
    }
    await kit.attempt(p, async (db, notify) => {
      const task = await loadTask(db, taskId, true);
      // Reassigned or restarted since: this answer is about a run that no longer matters.
      if (task.run_id !== runId || !live(task)) return;
      if (
        state.status === "awaiting_input" &&
        task.run_status !== "awaiting_input" &&
        state.question
      ) {
        await db.query(
          `insert into work.task_comment (workspace_id, space_id, task_id, author_type, body_md)
           values ($1, $2, $3, 'assistant', $4)`,
          [
            p.workspaceId,
            task.space_id,
            taskId,
            `Question: ${state.question}`.slice(0, SPACE_LIMITS.comment),
          ],
        );
      }
      if (!finished(state.status)) {
        if (state.status !== task.run_status) {
          await db.query("update work.task set run_status = $2 where id = $1", [
            taskId,
            state.status,
          ]);
        }
        return;
      }
      const outputs = [...task.linked.outputs];
      for (const out of state.outputs) {
        if (!outputs.some((o) => o.id === out.id && o.kind === out.kind)) outputs.push(out);
      }
      // Back to the person who made the task; its status stays In progress until they close it.
      await db.query(
        `update work.task
            set assignee_type = 'user', assignee_id = created_by, run_status = $2,
                linked = jsonb_set(linked, '{outputs}', $3::jsonb)
          where id = $1`,
        [taskId, state.status, JSON.stringify(outputs)],
      );
      const body =
        state.status === "done"
          ? `Completed: ${state.summary ?? "the run finished."}`
          : `Stopped: ${state.error ?? (state.status === "cancelled" ? "the run was cancelled." : "the run failed.")}`;
      await db.query(
        `insert into work.task_comment (workspace_id, space_id, task_id, author_type, body_md)
         values ($1, $2, $3, 'assistant', $4)`,
        [p.workspaceId, task.space_id, taskId, body.slice(0, SPACE_LIMITS.comment)],
      );
      await kit.audit(db, p, client, "task.returned", "task", taskId, {
        run_id: runId,
        status: state.status,
      });
      await kit.activity(
        db,
        p,
        task.space_id,
        "task.returned",
        { type: "task", id: taskId },
        { status: state.status },
        "agent",
      );
      notify({
        kind: "task.returned",
        userIds: [task.created_by],
        spaceId: task.space_id,
        taskId,
        label: task.name,
      });
    });
  }

  const checkMentions = async (db: Db, spaceId: string, mentions: string[]) => {
    for (const user of mentions) {
      const ok = isId(user)
        ? await one<{ ok: boolean }>(db, "select work.user_in_space($1, $2) as ok", [spaceId, user])
        : null;
      if (!ok?.ok) throw refusal("MENTION_NOT_VISIBLE");
    }
  };

  const commentRow = async (db: Db, taskId: string, commentId: string) => {
    const row = isId(commentId)
      ? await one<CommentRow>(db, `${COMMENT_SQL} where c.id = $1 and c.task_id = $2`, [
          commentId,
          taskId,
        ])
      : null;
    if (!row) throw refusal("NOT_FOUND");
    return row;
  };

  return {
    async phases(p, spaceId) {
      const r = await kit.attempt(p, async (db) =>
        (await roleOf(db, spaceId)) ? phaseViews(db, spaceId) : null,
      );
      return r.ok ? r.value : null;
    },

    async createPhase(p, spaceId, input, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, spaceId);
        const order = await orderOf(db, spaceId);
        if (order.length >= SPACE_LIMITS.phases) throw refusal("TOO_MANY");
        const made = await one<{ id: string }>(
          db,
          `insert into work.phase (workspace_id, space_id, ordinal, name)
           values ($1, $2, $3, $4) returning id`,
          [p.workspaceId, spaceId, order.length + 1, input.name],
        );
        const id = made?.id ?? "";
        if (input.after_phase_id) {
          const at = order.indexOf(input.after_phase_id);
          if (at < 0) throw refusal("NOT_FOUND");
          await renumber(db, [...order.slice(0, at + 1), id, ...order.slice(at + 1)]);
        }
        await kit.audit(db, p, client, "phase.created", "phase", id, { space_id: spaceId });
        await kit.activity(db, p, spaceId, "phase.created", { type: "phase", id });
        return phaseOf(db, spaceId, id);
      });
    },

    async patchPhase(p, spaceId, phaseId, patch, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, spaceId);
        await phaseOf(db, spaceId, phaseId);
        if (patch.name !== undefined) {
          await db.query("update work.phase set name = $2 where id = $1", [phaseId, patch.name]);
          await kit.audit(db, p, client, "phase.renamed", "phase", phaseId, { space_id: spaceId });
        }
        if (patch.ordinal !== undefined) {
          const order = (await orderOf(db, spaceId)).filter((id) => id !== phaseId);
          order.splice(Math.min(patch.ordinal, order.length + 1) - 1, 0, phaseId);
          await renumber(db, order);
          await kit.audit(db, p, client, "phase.reordered", "phase", phaseId, {
            space_id: spaceId,
          });
        }
        await kit.activity(db, p, spaceId, "phase.updated", { type: "phase", id: phaseId });
        return phaseViews(db, spaceId);
      });
    },

    async removePhase(p, spaceId, phaseId, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, spaceId);
        await phaseOf(db, spaceId, phaseId);
        // Its tasks keep existing, with no phase.
        await db.query("delete from work.phase where id = $1", [phaseId]);
        await renumber(db, await orderOf(db, spaceId));
        await kit.audit(db, p, client, "phase.deleted", "phase", phaseId, { space_id: spaceId });
        await kit.activity(db, p, spaceId, "phase.deleted", { type: "phase", id: phaseId });
        return null;
      });
    },

    async unlockPhase(p, spaceId, phaseId, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, spaceId);
        await phaseOf(db, spaceId, phaseId);
        await db.query("update work.phase set locked_override = true where id = $1", [phaseId]);
        await kit.audit(db, p, client, "phase.unlocked_manually", "phase", phaseId, {
          space_id: spaceId,
        });
        await kit.activity(db, p, spaceId, "phase.unlocked", { type: "phase", id: phaseId });
        return phaseOf(db, spaceId, phaseId);
      });
    },

    async list(p, spaceId, q) {
      const query = () =>
        kit.attempt(p, async (db) => {
          if (!(await roleOf(db, spaceId))) return null;
          const params: unknown[] = [spaceId];
          const where = ["t.space_id = $1"];
          if (q.assignee === "me") {
            params.push(p.userId);
            where.push(`t.assignee_type = 'user' and t.assignee_id = $${params.length}`);
          }
          if (q.status) {
            params.push(q.status);
            where.push(`t.status = $${params.length}`);
          }
          if (q.phaseId && isId(q.phaseId)) {
            params.push(q.phaseId);
            where.push(`t.phase_id = $${params.length}`);
          }
          return (
            await db.query<TaskRow>(
              `${TASK_SQL} where ${where.join(" and ")}
                order by (select ordinal from work.phase where id = t.phase_id) nulls last, t.id
                limit 500`,
              params,
            )
          ).rows;
        });
      const first = await query();
      if (!first.ok || !first.value) return null;
      // Settle any finished runs first, so the board shows tasks back with their assigner.
      const running = first.value.filter(live).slice(0, 20);
      if (running.length === 0) return first.value.map(taskView);
      for (const task of running) await sync(p, task.id, NO_CLIENT);
      const again = await query();
      return (again.ok && again.value ? again.value : first.value).map(taskView);
    },

    async get(p, taskId) {
      const first = await kit.attempt(p, (db) => loadTask(db, taskId));
      if (!first.ok) return null;
      if (live(first.value)) await sync(p, taskId, NO_CLIENT);
      const r = await kit.attempt(p, (db) => viewOf(db, taskId));
      return r.ok ? r.value : null;
    },

    async create(p, spaceId, input, client) {
      const made = await kit.attempt(p, async (db) => {
        await needMember(db, spaceId);
        if (input.phase_id) {
          // A locked phase can still be planned: only moving its tasks on is refused.
          await phaseOf(db, spaceId, input.phase_id);
          const count = await one<{ n: number }>(
            db,
            "select count(*)::int as n from work.task where phase_id = $1",
            [input.phase_id],
          );
          if ((count?.n ?? 0) >= SPACE_LIMITS.tasksPerPhase) throw refusal("TOO_MANY");
        }
        if (input.assignee) await validAssignee(db, spaceId, input.assignee);
        const [type, assigneeId] = assigneeColumns(input.assignee ?? null);
        const row = await one<{ id: string }>(
          db,
          `insert into work.task
             (workspace_id, space_id, phase_id, name, description_md, assignee_type, assignee_id,
              created_by, due_at, gate, linked)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [
            p.workspaceId,
            spaceId,
            input.phase_id ?? null,
            input.name,
            input.description_md ?? "",
            type,
            assigneeId,
            p.userId,
            input.due_at ?? null,
            input.gate ?? false,
            JSON.stringify({ resources: input.linked ?? [], outputs: [] }),
          ],
        );
        const id = row?.id ?? "";
        const details = { assignee_type: input.assignee?.type ?? null };
        await kit.audit(db, p, client, "task.created", "task", id, details);
        await kit.activity(db, p, spaceId, "task.created", { type: "task", id }, details);
        return id;
      });
      if (!made.ok) return made;
      if (input.assignee && input.assignee.type !== "user") return startRun(p, made.value, client);
      return kit.attempt(p, (db) => viewOf(db, made.value));
    },

    async patch(p, taskId, patch, client) {
      let toCancel: string | null = null;
      let needsRun = false;
      const done = await kit.attempt(p, async (db) => {
        const task = await loadTask(db, taskId, true);
        const role = await needMember(db, task.space_id);
        const sets: string[] = [];
        const params: unknown[] = [taskId];
        const set = (column: string, value: unknown) => {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        };

        if (patch.name !== undefined) set("name", patch.name);
        if (patch.description_md !== undefined) set("description_md", patch.description_md);
        if (patch.due_at !== undefined) set("due_at", patch.due_at);
        if (patch.phase_id !== undefined) {
          if (patch.phase_id !== null) await phaseOf(db, task.space_id, patch.phase_id);
          set("phase_id", patch.phase_id);
        }
        if (patch.linked !== undefined) {
          set("linked", JSON.stringify({ ...task.linked, resources: patch.linked }));
        }
        if (patch.gate !== undefined) {
          set("gate", patch.gate);
          if (!patch.gate) sets.push("awaiting_approval = false");
        }

        if (patch.assignee !== undefined) {
          const same = JSON.stringify(assigneeOf(task)) === JSON.stringify(patch.assignee);
          if (!same) {
            // Handing a task on while its run is live stops the run.
            if (live(task)) {
              toCancel = task.run_id;
              sets.push("run_status = 'cancelled'");
            }
            if (patch.assignee) await validAssignee(db, task.space_id, patch.assignee);
            const [type, assigneeId] = assigneeColumns(patch.assignee);
            set("assignee_type", type);
            set("assignee_id", assigneeId);
            if (patch.assignee && patch.assignee.type !== "user") {
              needsRun = true;
              sets.push("run_id = null", "thread_id = null", "run_status = null");
            }
          }
        }

        let status = patch.status;
        if (status !== undefined && status !== task.status) {
          const gate = patch.gate ?? task.gate;
          if (status === "done" && gate) {
            if (role === "admin") {
              set("status", "done");
              set("approved_by", p.userId);
              sets.push("approved_at = now()", "awaiting_approval = false");
            } else {
              // A collaborator can't close a gate: it waits for an admin.
              set("status", "in_progress");
              sets.push("awaiting_approval = true");
              status = "in_progress";
            }
          } else {
            set("status", status);
            sets.push("awaiting_approval = false");
            // Reopening an approved gate takes the approval back, so its phase locks again.
            if (task.status === "done") sets.push("approved_by = null", "approved_at = null");
            if (status === "cancelled" && live(task) && !toCancel) {
              toCancel = task.run_id;
              sets.push("run_status = 'cancelled'");
            }
          }
        }
        if (sets.length > 0) {
          await db.query(`update work.task set ${sets.join(", ")} where id = $1`, params);
        }
        if (status !== undefined && status !== task.status) {
          const details = { from: task.status, to: status };
          await kit.audit(db, p, client, "task.status_changed", "task", taskId, details);
          await kit.activity(
            db,
            p,
            task.space_id,
            "task.status_changed",
            { type: "task", id: taskId },
            details,
          );
        } else if (sets.length > 0) {
          await kit.audit(db, p, client, "task.updated", "task", taskId, {
            fields: Object.keys(patch),
          });
        }
        return viewOf(db, taskId);
      });
      if (!done.ok) return done;
      if (toCancel) await runs.cancel(callerOf(p), toCancel).catch(() => {});
      if (needsRun) return startRun(p, taskId, client);
      return done;
    },

    async approve(p, taskId, client) {
      return kit.attempt(p, async (db) => {
        const task = await loadTask(db, taskId, true);
        await needAdmin(db, task.space_id);
        if (!task.awaiting_approval) throw refusal("NOT_AWAITING_APPROVAL");
        await db.query(
          `update work.task
              set status = 'done', awaiting_approval = false, approved_by = $2, approved_at = now()
            where id = $1`,
          [taskId, p.userId],
        );
        await kit.audit(db, p, client, "task.gate_approved", "task", taskId, {});
        await kit.activity(db, p, task.space_id, "task.approved", { type: "task", id: taskId });
        await noteUnlocked(db, p, task);
        return viewOf(db, taskId);
      });
    },

    async reject(p, taskId, comment, client) {
      return kit.attempt(p, async (db, notify) => {
        const task = await loadTask(db, taskId, true);
        await needAdmin(db, task.space_id);
        if (!task.awaiting_approval) throw refusal("NOT_AWAITING_APPROVAL");
        if (!comment.trim()) throw refusal("COMMENT_REQUIRED");
        await db.query(
          "update work.task set status = 'todo', awaiting_approval = false where id = $1",
          [taskId],
        );
        await db.query(
          `insert into work.task_comment (workspace_id, space_id, task_id, author_id, body_md)
           values ($1, $2, $3, $4, $5)`,
          [p.workspaceId, task.space_id, taskId, p.userId, comment.slice(0, SPACE_LIMITS.comment)],
        );
        await kit.audit(db, p, client, "task.gate_rejected", "task", taskId, {});
        await kit.activity(db, p, task.space_id, "task.rejected", { type: "task", id: taskId });
        notify({
          kind: "task.returned",
          userIds: [task.created_by],
          spaceId: task.space_id,
          taskId,
          label: task.name,
        });
        return viewOf(db, taskId);
      });
    },

    async answer(p, taskId, answer, client) {
      const found = await kit.attempt(p, async (db) => {
        const task = await loadTask(db, taskId);
        await needMember(db, task.space_id);
        if (!task.run_id || task.run_status !== "awaiting_input") throw refusal("NO_RUN");
        await db.query(
          `insert into work.task_comment (workspace_id, space_id, task_id, author_id, body_md)
           values ($1, $2, $3, $4, $5)`,
          [p.workspaceId, task.space_id, taskId, p.userId, answer.slice(0, SPACE_LIMITS.comment)],
        );
        await db.query("update work.task set run_status = 'running' where id = $1", [taskId]);
        return task.run_id;
      });
      if (!found.ok) return found;
      await runs.answer?.(callerOf(p), found.value, answer);
      await sync(p, taskId, client);
      return kit.attempt(p, (db) => viewOf(db, taskId));
    },

    async runFinished(caller, runId, client) {
      const p: Principal = {
        sessionId: "",
        userId: caller.userId,
        workspaceId: caller.workspaceId,
      };
      const row = await kit.attempt(p, async (db) =>
        isId(runId)
          ? await one<{ id: string }>(db, "select id from work.task where run_id = $1", [runId])
          : null,
      );
      if (!row.ok || !row.value) return { ok: true, value: null };
      const taskId = row.value.id;
      await sync(p, taskId, client);
      return kit.attempt(p, (db) => viewOf(db, taskId));
    },

    async comments(p, taskId) {
      const r = await kit.attempt(p, async (db) => {
        const task = await loadTask(db, taskId);
        if (!(await roleOf(db, task.space_id))) return null;
        const rows = await db.query<CommentRow>(
          `${COMMENT_SQL} where c.task_id = $1 order by c.created_at, c.id`,
          [taskId],
        );
        return rows.rows.map(commentView);
      });
      return r.ok ? r.value : null;
    },

    async addComment(p, taskId, input, client) {
      return kit.attempt(p, async (db, notify) => {
        const task = await loadTask(db, taskId);
        await needMember(db, task.space_id);
        const mentions = [...new Set(input.mentions ?? [])];
        await checkMentions(db, task.space_id, mentions);
        const made = await one<{ id: string }>(
          db,
          `insert into work.task_comment (workspace_id, space_id, task_id, author_id, body_md, mentions)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [p.workspaceId, task.space_id, taskId, p.userId, input.body_md, mentions],
        );
        await kit.audit(db, p, client, "task.comment_added", "task", taskId, {
          mentions_count: mentions.length,
        });
        // The body is content; the feed only says a comment was added.
        await kit.activity(db, p, task.space_id, "task.comment", { type: "task", id: taskId });
        if (mentions.length) {
          notify({
            kind: "mention",
            userIds: mentions,
            spaceId: task.space_id,
            taskId,
            label: task.name,
          });
        }
        return commentView(await commentRow(db, taskId, made?.id ?? ""));
      });
    },

    async editComment(p, taskId, commentId, bodyMd, client) {
      return kit.attempt(p, async (db) => {
        const task = await loadTask(db, taskId);
        await needMember(db, task.space_id);
        const row = await commentRow(db, taskId, commentId);
        if (row.deleted_at) throw refusal("NOT_FOUND");
        // Only their author, and only for a short while.
        if (row.author_type !== "user" || row.author_id !== p.userId) throw refusal("FORBIDDEN");
        if (now() - row.created_at.getTime() > SPACE_LIMITS.commentEditMinutes * 60_000) {
          throw refusal("EDIT_WINDOW_CLOSED");
        }
        await db.query(
          "update work.task_comment set body_md = $2, edited_at = now() where id = $1",
          [commentId, bodyMd],
        );
        await kit.audit(db, p, client, "task.comment_edited", "task", taskId, {});
        return commentView(await commentRow(db, taskId, commentId));
      });
    },

    async removeComment(p, taskId, commentId, client) {
      return kit.attempt(p, async (db) => {
        const task = await loadTask(db, taskId);
        const role = await needMember(db, task.space_id);
        const row = await commentRow(db, taskId, commentId);
        if (row.deleted_at) return null;
        if (row.author_id !== p.userId && role !== "admin") throw refusal("FORBIDDEN");
        // A tombstone: the place stays, the words go.
        await db.query(
          "update work.task_comment set body_md = '', mentions = '{}', deleted_at = now() where id = $1",
          [commentId],
        );
        await kit.audit(db, p, client, "task.comment_deleted", "task", taskId, {});
        return null;
      });
    },

    async exportCsv(p, spaceId, client) {
      return kit.attempt(p, async (db) => {
        await needMember(db, spaceId);
        const rows = await db.query<{
          name: string;
          phase: string | null;
          status: string;
          assignee: string | null;
          due: string | null;
          gate: boolean;
          awaiting: boolean;
        }>(
          `select t.name, ph.name as phase, t.status,
                  case t.assignee_type when 'user' then coalesce(nullif(u.name, ''), u.email)
                       when 'assistant' then 'Assistant' when 'agent' then 'Agent' end as assignee,
                  to_char(t.due_at, 'YYYY-MM-DD') as due, t.gate, t.awaiting_approval as awaiting
             from work.task t
             left join work.phase ph on ph.id = t.phase_id
             left join core."user" u on t.assignee_type = 'user' and u.id = t.assignee_id
            where t.space_id = $1 order by ph.ordinal nulls last, t.id`,
          [spaceId],
        );
        await kit.audit(db, p, client, "task.exported", "space", spaceId, {
          rows: rows.rows.length,
        });
        const lines = [["Task", "Phase", "Status", "Assignee", "Due", "Gate", "Awaiting approval"]];
        for (const r of rows.rows) {
          lines.push([
            r.name,
            r.phase ?? "",
            r.status,
            r.assignee ?? "",
            r.due ?? "",
            r.gate ? "yes" : "no",
            r.awaiting ? "yes" : "no",
          ]);
        }
        return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
      });
    },
  };
}
