import {
  CommentInput,
  MemberInput,
  PhaseInput,
  PhasePatch,
  ResourceInput,
  SpaceContextInput,
  SpaceCreate,
  SpaceLevel,
  SpacePatch,
  SpaceRole,
  TaskCreate,
  TaskPatch,
  TaskStatus,
  TemplateInput,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Failure, Result } from "./kit.js";
import type { SpaceModule } from "./module.js";
import type {
  AccessRequestView,
  ActivityView,
  DirectoryEntry,
  MemberView,
  ResourceView,
  SpaceView,
} from "./spaces.js";
import type { CommentView, PhaseView, TaskView } from "./tasks.js";
import type { TemplateView } from "./templates.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<Failure, { status: 400 | 403 | 404 | 409 | 502; message: string }> = {
  NOT_FOUND: { status: 404, message: "That wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have permission to do that." },
  INVALID: { status: 400, message: "Check the details and try again." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
  MATTER_HAS_SPACE: { status: 409, message: "That matter already has a Space." },
  NAME_TAKEN: { status: 409, message: "A Space with that name already exists." },
  EXTERNAL_NOT_ENABLED: { status: 403, message: "External Spaces aren't available yet." },
  ALREADY_MEMBER: { status: 409, message: "They are already in this Space." },
  NOT_MEMBER: { status: 400, message: "Choose someone in this workspace." },
  LAST_ADMIN: { status: 409, message: "A Space needs at least one admin." },
  RESOURCE_NOT_FOUND: { status: 404, message: "That resource wasn't found." },
  RESOURCE_UNSUPPORTED: { status: 400, message: "That kind of resource can't be shared yet." },
  MATTER_MISMATCH: {
    status: 409,
    message: "That resource belongs to a different matter than this Space.",
  },
  PHASE_LOCKED: {
    status: 409,
    message: "That phase is locked until the earlier gate is approved.",
  },
  GATE_NEEDS_APPROVAL: { status: 409, message: "A gate task is finished by approving it." },
  NOT_AWAITING_APPROVAL: { status: 409, message: "That task isn't waiting for approval." },
  NOT_A_GATE: { status: 409, message: "That task isn't a gate." },
  AGENT_NOT_SHARED: { status: 400, message: "Share the agent into this Space to run it here." },
  INVALID_ASSIGNEE: { status: 400, message: "Assign to someone in this Space." },
  MENTION_NOT_VISIBLE: { status: 400, message: "Only people in this Space can be mentioned." },
  COMMENT_REQUIRED: { status: 400, message: "Say why in a comment." },
  EDIT_WINDOW_CLOSED: { status: 409, message: "A comment can be edited for 15 minutes." },
  TOO_MANY: { status: 409, message: "That is the most there can be." },
  RUN_START_FAILED: { status: 502, message: "The run couldn't be started. Try again." },
  NO_RUN: { status: 409, message: "There is no question waiting." },
  ALREADY_REQUESTED: { status: 409, message: "You've already asked to join." },
  ALREADY_DECIDED: { status: 409, message: "That request was already answered." },
};

const small = bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => c.json({ code: "INVALID_REQUEST", message: "That was too large." }, 400),
});
const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
const notFound = (c: Context) => c.json({ code: "NOT_FOUND", message: "That wasn't found." }, 404);

const spaceJson = (s: SpaceView) => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  matter: s.matter,
  context: s.context,
  customization: s.customization,
  my_role: s.myRole,
  template_id: s.templateId,
  external_parties: s.externalParties,
  counts: {
    members: s.counts.members,
    resources: s.counts.resources,
    open_tasks: s.counts.openTasks,
  },
  created_by: s.createdBy,
  created_at: s.createdAt,
});
const directoryJson = (d: DirectoryEntry) => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  matter_id: d.matterId,
  locked: d.locked,
});
const memberJson = (m: MemberView) => ({
  id: m.id,
  principal_type: m.principalType,
  principal_id: m.principalId,
  label: m.label,
  role: m.role,
  joined_at: m.joinedAt,
});
const resourceJson = (r: ResourceView) => ({
  id: r.id,
  resource_type: r.resourceType,
  resource_id: r.resourceId,
  name: r.name,
  access: r.access,
  external_parties: r.externalParties,
  granted_by: r.grantedBy,
  created_at: r.createdAt,
});
const activityJson = (a: ActivityView) => ({
  id: a.id,
  type: a.type,
  actor_type: a.actorType,
  actor_id: a.actorId,
  actor_name: a.actorName,
  object_type: a.objectType,
  object_id: a.objectId,
  details: a.details,
  at: a.at,
});
const requestJson = (r: AccessRequestView) => ({
  id: r.id,
  user_id: r.userId,
  user_name: r.userName,
  message: r.message,
  status: r.status,
  created_at: r.createdAt,
});
const phaseJson = (p: PhaseView) => ({
  id: p.id,
  ordinal: p.ordinal,
  name: p.name,
  locked: p.locked,
  gate_pending: p.gatePending,
});
const taskJson = (t: TaskView) => ({
  id: t.id,
  space_id: t.spaceId,
  phase_id: t.phaseId,
  name: t.name,
  description_md: t.descriptionMd,
  assignee: t.assignee,
  created_by: t.createdBy,
  due_at: t.dueAt,
  status: t.status,
  awaiting_approval: t.awaitingApproval,
  locked: t.locked,
  gate: t.gate,
  linked: t.linked,
  run: t.run ? { id: t.run.id, status: t.run.status, thread_id: t.run.threadId } : null,
  approved_by: t.approvedBy,
  approved_at: t.approvedAt,
  comments_count: t.commentsCount,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
});
const commentJson = (c: CommentView) => ({
  id: c.id,
  task_id: c.taskId,
  author_type: c.authorType,
  author_id: c.authorId,
  author_name: c.authorName,
  body_md: c.bodyMd,
  mentions: c.mentions,
  edited_at: c.editedAt,
  deleted: c.deleted,
  created_at: c.createdAt,
});
const templateJson = (t: TemplateView) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  owner_id: t.ownerId,
  shared_to: { workspace: t.sharedTo.workspace, group_ids: t.sharedTo.groupIds },
  definition: t.definition,
  mine: t.mine,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
});

const roleBody = z.object({ role: SpaceRole }).strict();
const levelBody = z.object({ access: SpaceLevel }).strict();
const messageBody = z.object({ message: z.string().trim().max(1000).default("") }).strict();
const decideBody = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("accept") }).strict(),
    z.object({ decision: z.literal("deny"), reason: z.string().trim().min(1).max(1000) }).strict(),
  ])
  .transform((d) =>
    d.decision === "accept"
      ? { accept: true as const }
      : { accept: false as const, reason: d.reason },
  );
const commentBody = z.object({ body_md: CommentInput.shape.body_md }).strict();
const rejectBody = z.object({ comment: z.string().max(5000).default("") }).strict();
const answerBody = z.object({ answer: z.string().trim().min(1).max(5000) }).strict();
const applyBody = z.object({ template_id: z.string().uuid() }).strict();
const matterBody = z.object({ matter_id: z.string().uuid() }).strict();
const templatePatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    shared_to: z
      .object({ workspace: z.boolean(), group_ids: z.array(z.string().uuid()).max(50) })
      .strict()
      .optional(),
  })
  .strict();
const taskFilter = z.object({
  "filter[assignee]": z.literal("me").optional(),
  "filter[status]": TaskStatus.optional(),
  "filter[phase_id]": z.string().max(64).optional(),
});

export function spaceHttp(module: SpaceModule, clientOf: (c: Context) => Client) {
  const { spaces, tasks, templates } = module;
  const app = new Hono<Env>();

  const respond = <T>(
    c: Context<Env>,
    result: Result<T>,
    json: (value: T) => object,
    status: 200 | 201 = 200,
  ) => {
    if (!result.ok) {
      const failure = FAILURES[result.reason];
      return c.json({ code: result.reason, message: failure.message }, failure.status);
    }
    return c.json(json(result.value), status);
  };
  const empty = (c: Context<Env>, result: Result<null>) =>
    result.ok ? c.body(null, 204) : respond(c, result, () => ({}));
  const body = async <S extends z.ZodType>(c: Context, schema: S) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? (parsed.data as z.output<S>) : null;
  };
  const me = (c: Context<Env>) => c.get("principal");
  const param = (c: Context<Env>, name: string) => c.req.param(name) ?? "";
  const client = (c: Context<Env>) => clientOf(c);

  // --- Spaces ---
  app.get("/spaces", async (c) => {
    const q = c.req.query("q")?.trim().slice(0, 100);
    const list = await spaces.list(me(c), {
      ...(q ? { q } : {}),
      memberOnly: c.req.query("filter[member]") === "me",
    });
    return c.json({ spaces: list.map(spaceJson) });
  });
  // The "Work in" picker: Spaces the caller can reach, locked when they aren't in one.
  app.get("/spaces/directory", async (c) => {
    const q = c.req.query("q")?.trim().slice(0, 100);
    return c.json({ spaces: (await spaces.directory(me(c), q || undefined)).map(directoryJson) });
  });
  app.get("/work-in", async (c) => {
    const matter = c.req.query("matter_id");
    const space = c.req.query("space_id");
    if (!matter === !space) return invalid(c);
    const result = await spaces.workIn(
      me(c),
      matter ? { matterId: matter } : { spaceId: space ?? "" },
    );
    return respond(c, result, (v) => ({
      matter_id: v.matterId,
      space_id: v.spaceId,
      locked: v.locked,
    }));
  });
  app.post("/spaces", small, async (c) => {
    const input = await body(c, SpaceCreate);
    if (!input) return invalid(c);
    const result = await spaces.create(me(c), input, client(c));
    return respond(c, result, (v) => ({ space: spaceJson(v.space), skipped: v.skipped }), 201);
  });
  app.get("/spaces/:id", async (c) => {
    const space = await spaces.get(me(c), param(c, "id"));
    return space ? c.json({ space: spaceJson(space) }) : notFound(c);
  });
  app.patch("/spaces/:id", small, async (c) => {
    const input = await body(c, SpacePatch);
    if (!input) return invalid(c);
    const result = await spaces.patch(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (s) => ({ space: spaceJson(s) }));
  });
  app.delete("/spaces/:id", async (c) =>
    empty(c, await spaces.remove(me(c), param(c, "id"), client(c))),
  );
  app.put("/spaces/:id/context", small, async (c) => {
    const input = await body(c, SpaceContextInput);
    if (!input) return invalid(c);
    const result = await spaces.setContext(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (s) => ({ space: spaceJson(s) }));
  });
  app.put("/spaces/:id/matter", small, async (c) => {
    const input = await body(c, matterBody);
    if (!input) return invalid(c);
    const result = await spaces.attachMatter(me(c), param(c, "id"), input.matter_id, client(c));
    return respond(c, result, (s) => ({ space: spaceJson(s) }));
  });

  // --- Members ---
  app.get("/spaces/:id/members", async (c) => {
    const list = await spaces.members(me(c), param(c, "id"));
    return list ? c.json({ members: list.map(memberJson) }) : notFound(c);
  });
  app.post("/spaces/:id/members", small, async (c) => {
    const input = await body(c, MemberInput);
    if (!input) return invalid(c);
    const result = await spaces.addMember(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (m) => ({ member: memberJson(m) }), 201);
  });
  app.patch("/spaces/:id/members/:member", small, async (c) => {
    const input = await body(c, roleBody);
    if (!input) return invalid(c);
    const result = await spaces.setRole(
      me(c),
      param(c, "id"),
      param(c, "member"),
      input.role,
      client(c),
    );
    return respond(c, result, (m) => ({ member: memberJson(m) }));
  });
  app.delete("/spaces/:id/members/:member", async (c) =>
    empty(c, await spaces.removeMember(me(c), param(c, "id"), param(c, "member"), client(c))),
  );

  // --- Resources ---
  app.get("/spaces/:id/resources", async (c) => {
    const list = await spaces.resources(me(c), param(c, "id"));
    return list ? c.json({ resources: list.map(resourceJson) }) : notFound(c);
  });
  app.post("/spaces/:id/resources", small, async (c) => {
    const input = await body(c, ResourceInput);
    if (!input) return invalid(c);
    const result = await spaces.addResource(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (r) => ({ resource: resourceJson(r) }), 201);
  });
  app.patch("/spaces/:id/resources/:rid", small, async (c) => {
    const input = await body(c, levelBody);
    if (!input) return invalid(c);
    const result = await spaces.setResourceLevel(
      me(c),
      param(c, "id"),
      param(c, "rid"),
      input.access,
      client(c),
    );
    return respond(c, result, (r) => ({ resource: resourceJson(r) }));
  });
  app.delete("/spaces/:id/resources/:rid", async (c) =>
    empty(c, await spaces.removeResource(me(c), param(c, "id"), param(c, "rid"), client(c))),
  );

  // --- Activity and access requests ---
  app.get("/spaces/:id/activity", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const type = c.req.query("filter[type]");
    const actor = c.req.query("filter[actor]");
    const cursor = c.req.query("cursor");
    const out = await spaces.activity(me(c), param(c, "id"), {
      ...(type ? { type } : {}),
      ...(actor ? { actorId: actor } : {}),
      ...(cursor ? { before: cursor } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return out
      ? c.json({ items: out.items.map(activityJson), next_cursor: out.next })
      : notFound(c);
  });
  app.get("/spaces/:id/requests", async (c) => {
    const list = await spaces.requests(me(c), param(c, "id"));
    return list ? c.json({ access: list.map(requestJson) }) : notFound(c);
  });
  app.post("/spaces/:id/access-requests", small, async (c) => {
    const input = await body(c, messageBody);
    if (!input) return invalid(c);
    const result = await spaces.requestAccess(me(c), param(c, "id"), input.message, client(c));
    return respond(c, result, (r) => ({ request: requestJson(r) }), 201);
  });
  app.post("/spaces/:id/access-requests/:rid", small, async (c) => {
    const input = await body(c, decideBody);
    if (!input) return invalid(c);
    const result = await spaces.decideRequest(
      me(c),
      param(c, "id"),
      param(c, "rid"),
      input,
      client(c),
    );
    return respond(c, result, (r) => ({ request: requestJson(r) }));
  });

  // --- Phases ---
  app.get("/spaces/:id/phases", async (c) => {
    const list = await tasks.phases(me(c), param(c, "id"));
    return list ? c.json({ phases: list.map(phaseJson) }) : notFound(c);
  });
  app.post("/spaces/:id/phases", small, async (c) => {
    const input = await body(c, PhaseInput);
    if (!input) return invalid(c);
    const result = await tasks.createPhase(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (p) => ({ phase: phaseJson(p) }), 201);
  });
  app.patch("/spaces/:id/phases/:pid", small, async (c) => {
    const input = await body(c, PhasePatch);
    if (!input) return invalid(c);
    const result = await tasks.patchPhase(me(c), param(c, "id"), param(c, "pid"), input, client(c));
    return respond(c, result, (list) => ({ phases: list.map(phaseJson) }));
  });
  app.delete("/spaces/:id/phases/:pid", async (c) =>
    empty(c, await tasks.removePhase(me(c), param(c, "id"), param(c, "pid"), client(c))),
  );
  app.post("/spaces/:id/phases/:pid/unlock", async (c) => {
    const result = await tasks.unlockPhase(me(c), param(c, "id"), param(c, "pid"), client(c));
    return respond(c, result, (p) => ({ phase: phaseJson(p) }));
  });

  // --- Tasks ---
  app.get("/spaces/:id/tasks/export", async (c) => {
    const result = await tasks.exportCsv(me(c), param(c, "id"), client(c));
    if (!result.ok) return respond(c, result, () => ({}));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="tasks.csv"');
    return c.body(result.value);
  });
  app.get("/spaces/:id/tasks", async (c) => {
    const f = taskFilter.safeParse(c.req.query());
    if (!f.success) return invalid(c);
    const status = f.data["filter[status]"];
    const phase = f.data["filter[phase_id]"];
    const list = await tasks.list(me(c), param(c, "id"), {
      ...(f.data["filter[assignee]"] ? { assignee: "me" as const } : {}),
      ...(status ? { status } : {}),
      ...(phase ? { phaseId: phase } : {}),
    });
    return list ? c.json({ tasks: list.map(taskJson) }) : notFound(c);
  });
  app.post("/spaces/:id/tasks", small, async (c) => {
    const input = await body(c, TaskCreate);
    if (!input) return invalid(c);
    const result = await tasks.create(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (t) => ({ task: taskJson(t) }), 201);
  });
  app.get("/tasks/:id", async (c) => {
    const task = await tasks.get(me(c), param(c, "id"));
    return task ? c.json({ task: taskJson(task) }) : notFound(c);
  });
  app.patch("/tasks/:id", small, async (c) => {
    const input = await body(c, TaskPatch);
    if (!input) return invalid(c);
    const result = await tasks.patch(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (t) => ({ task: taskJson(t) }));
  });
  app.post("/tasks/:id/approve", async (c) => {
    const result = await tasks.approve(me(c), param(c, "id"), client(c));
    return respond(c, result, (t) => ({ task: taskJson(t) }));
  });
  app.post("/tasks/:id/reject", small, async (c) => {
    const input = await body(c, rejectBody);
    if (!input) return invalid(c);
    const result = await tasks.reject(me(c), param(c, "id"), input.comment, client(c));
    return respond(c, result, (t) => ({ task: taskJson(t) }));
  });
  app.post("/tasks/:id/answer", small, async (c) => {
    const input = await body(c, answerBody);
    if (!input) return invalid(c);
    const result = await tasks.answer(me(c), param(c, "id"), input.answer, client(c));
    return respond(c, result, (t) => ({ task: taskJson(t) }));
  });
  app.get("/tasks/:id/comments", async (c) => {
    const list = await tasks.comments(me(c), param(c, "id"));
    return list ? c.json({ comments: list.map(commentJson) }) : notFound(c);
  });
  app.post("/tasks/:id/comments", small, async (c) => {
    const input = await body(c, CommentInput);
    if (!input) return invalid(c);
    const result = await tasks.addComment(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (m) => ({ comment: commentJson(m) }), 201);
  });
  app.patch("/tasks/:id/comments/:cid", small, async (c) => {
    const input = await body(c, commentBody);
    if (!input) return invalid(c);
    const result = await tasks.editComment(
      me(c),
      param(c, "id"),
      param(c, "cid"),
      input.body_md,
      client(c),
    );
    return respond(c, result, (m) => ({ comment: commentJson(m) }));
  });
  app.delete("/tasks/:id/comments/:cid", async (c) =>
    empty(c, await tasks.removeComment(me(c), param(c, "id"), param(c, "cid"), client(c))),
  );

  // --- Templates ---
  app.get("/space-templates", async (c) =>
    c.json({ templates: (await templates.list(me(c))).map(templateJson) }),
  );
  app.post("/space-templates", small, async (c) => {
    const input = await body(c, TemplateInput);
    if (!input) return invalid(c);
    const result = await templates.create(me(c), input, client(c));
    return respond(c, result, (t) => ({ template: templateJson(t) }), 201);
  });
  app.get("/space-templates/:id", async (c) => {
    const t = await templates.get(me(c), param(c, "id"));
    return t ? c.json({ template: templateJson(t) }) : notFound(c);
  });
  app.patch("/space-templates/:id", small, async (c) => {
    const input = await body(c, templatePatch);
    if (!input) return invalid(c);
    const result = await templates.update(me(c), param(c, "id"), input, client(c));
    return respond(c, result, (t) => ({ template: templateJson(t) }));
  });
  app.delete("/space-templates/:id", async (c) =>
    empty(c, await templates.remove(me(c), param(c, "id"), client(c))),
  );
  app.post("/spaces/:id/apply-template", small, async (c) => {
    const input = await body(c, applyBody);
    if (!input) return invalid(c);
    const result = await templates.applyTo(me(c), input.template_id, param(c, "id"), client(c));
    return respond(c, result, (v) => ({ skipped: v.skipped }));
  });

  return app;
}
