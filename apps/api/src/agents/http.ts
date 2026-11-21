import {
  AGENT_LIMITS,
  AgentMode,
  AgentPatch,
  AgentRunBody,
  AgentRunError,
  AgentVersionInput,
  ApprovalConfig,
  ImportConfirm,
  Schedule,
  ShareDecision,
  ShareRequestBody,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AgentRuns } from "../agent-runs/runs.js";
import type { Client, Principal } from "../auth/auth.js";
import type { AgentFailure, Agents } from "./agents.js";
import type { AgentSharing } from "./config.js";
import type { Nudges } from "./nudges.js";

type Env = { Variables: { principal: Principal } };
type Status = 400 | 403 | 404 | 409 | 410 | 422 | 503;

const FAILURES: Record<AgentFailure, { status: Status; message: string }> = {
  NOT_FOUND: { status: 404, message: "That agent wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that with this agent." },
  AGENT_EMPTY_INSTRUCTIONS: { status: 400, message: "Add instructions before saving." },
  AGENT_ATTACHMENT_LIMIT: { status: 400, message: "An agent can hold up to 50 attachments." },
  AGENT_SOURCE_LIMIT: { status: 400, message: "An agent can use up to 5 sources." },
  AGENT_LABEL_DUPLICATE: {
    status: 400,
    message: "Each attachment and source needs its own label.",
  },
  WALL_DENIED: { status: 403, message: "An attachment isn't available to you." },
  SCHEDULE_REQUIRES_LIVE: { status: 400, message: "Save the agent before scheduling it." },
  LEVEL_REQUIRES_BUILD_PERMISSION: {
    status: 400,
    message: "Only builders can be given Edit or Full.",
  },
  GUEST_RUN_ONLY: { status: 400, message: "Guests can only run an agent shared through a Space." },
  SPACE_INVITE_DENIED: { status: 403, message: "You can't share into that Space." },
  SHARE_REQUEST_COOLDOWN: {
    status: 409,
    message: "That request was denied recently. Try again later.",
  },
  INVALID_PRINCIPAL: { status: 422, message: "Pick a person, group, Space or the workspace." },
  IMPORT_EXPIRED: { status: 410, message: "That import expired. Upload the file again." },
  NO_DRAFT: { status: 409, message: "There is no draft to work on." },
  UPLOADS_UNAVAILABLE: { status: 503, message: "Files can't be stored right now." },
};

const BUNDLE_CODES: Record<string, { status: Status; message: string }> = {
  SKILL_NO_INSTRUCTIONS: { status: 400, message: "No instructions were found in that file." },
  SKILL_MANIFEST_INVALID: { status: 400, message: "The manifest in that file isn't valid." },
  SKILL_UNSAFE_ARCHIVE: {
    status: 400,
    message: "That archive holds paths or files that aren't allowed.",
  },
  SKILL_TOO_LARGE: { status: 400, message: "That file is too large." },
  SKILL_UNREADABLE: { status: 400, message: "That file couldn't be read." },
  AGENT_INSTRUCTIONS_TOO_LONG: {
    status: 400,
    message: "Instructions are limited to 20,000 characters.",
  },
};

const listQuery = z.object({
  owner: z.enum(["me", "shared", "all"]).optional(),
  scheduled: z.enum(["true", "false"]).optional(),
  practice_area: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
});
const CreateBody = z.object({
  title: z.string().trim().max(AGENT_LIMITS.title).optional(),
  mode: AgentMode,
});

export function agentHttp(options: {
  agents: Agents;
  runs?: AgentRuns | undefined;
  sharing?: AgentSharing | undefined;
  nudges?: Nudges | undefined;
  clientOf: (c: Context) => Client;
}) {
  const { agents, runs, clientOf } = options;
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });

  const fail = (c: Context, code: AgentFailure, detail?: unknown) => {
    const f = FAILURES[code];
    return c.json(
      { code, message: f.message, ...(detail === undefined ? {} : { detail }) },
      f.status,
    );
  };
  const bad = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the request." }, 400);
  async function parse<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T> | null> {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? (parsed.data as z.output<T>) : null;
  }

  app.get("/agents", async (c) => {
    const q = listQuery.safeParse({
      owner: c.req.query("filter[owner]"),
      scheduled: c.req.query("filter[scheduled]"),
      practice_area: c.req.query("filter[practice_area]"),
      q: c.req.query("q") || undefined,
    });
    if (!q.success) return bad(c);
    const found = await agents.list(c.get("principal"), {
      ...(q.data.owner ? { owner: q.data.owner } : {}),
      ...(q.data.scheduled ? { scheduled: q.data.scheduled === "true" } : {}),
      ...(q.data.practice_area ? { practice_area: q.data.practice_area } : {}),
      ...(q.data.q ? { q: q.data.q } : {}),
    });
    return c.json({ agents: found });
  });

  app.post("/agents", limitBody, async (c) => {
    const body = await parse(c, CreateBody);
    if (!body) return bad(c);
    const r = await agents.create(c.get("principal"), body, clientOf(c));
    return r.ok ? c.json({ agent: r.agent }, 201) : fail(c, r.code);
  });

  // Before /agents/:id so "import" is never read as an id.
  app.post(
    "/agents/import",
    bodyLimit({
      maxSize: AGENT_LIMITS.bundleBytes + 1024,
      onError: (c) => c.json({ code: "TOO_LARGE", message: "That file is too large." }, 413),
    }),
    async (c) => {
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.file;
      if (!(file instanceof File)) return bad(c);
      const result = await agents.importPreview(c.get("principal"), {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (result.ok) return c.json(result);
      const f = BUNDLE_CODES[result.code] ?? {
        status: 400 as const,
        message: "That file can't be imported.",
      };
      return c.json(
        {
          code: result.code,
          message: f.message,
          ...(result.issues ? { issues: result.issues } : {}),
        },
        f.status,
      );
    },
  );
  app.post("/agents/import/:token/confirm", limitBody, async (c) => {
    const body = await parse(c, ImportConfirm);
    if (!body) return bad(c);
    const r = await agents.confirmImport(
      c.get("principal"),
      c.req.param("token"),
      body,
      clientOf(c),
    );
    return r.ok ? c.json({ agent: r.agent }, 201) : fail(c, r.code);
  });

  app.get("/agents/:id", async (c) => {
    const r = await agents.get(c.get("principal"), c.req.param("id"));
    return r ? c.json({ agent: r.agent }) : fail(c, "NOT_FOUND");
  });

  app.patch("/agents/:id", limitBody, async (c) => {
    const body = await parse(c, AgentPatch);
    if (!body) return bad(c);
    const r = await agents.patch(c.get("principal"), c.req.param("id"), body, clientOf(c));
    return r.ok ? c.json({ agent: r.agent }) : fail(c, r.code);
  });

  app.delete("/agents/:id", async (c) => {
    const r = await agents.remove(c.get("principal"), c.req.param("id"), clientOf(c));
    return r.ok ? c.body(null, 204) : fail(c, r.code);
  });

  app.post("/agents/:id/duplicate", async (c) => {
    const r = await agents.duplicate(c.get("principal"), c.req.param("id"), clientOf(c));
    return r.ok ? c.json({ agent: r.agent }, 201) : fail(c, r.code);
  });

  app.get("/agents/:id/versions", async (c) => {
    const v = await agents.versions(c.get("principal"), c.req.param("id"));
    return v ? c.json({ versions: v }) : fail(c, "NOT_FOUND");
  });

  app.post(
    "/agents/:id/versions",
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) => c.json({ code: "TOO_LARGE", message: "Too large." }, 413),
    }),
    async (c) => {
      const body = await parse(c, AgentVersionInput);
      if (!body) return bad(c);
      const r = await agents.saveVersion(c.get("principal"), c.req.param("id"), body, clientOf(c));
      return r.ok
        ? c.json({ version: r.version, warnings: r.warnings }, 201)
        : fail(c, r.code, r.detail);
    },
  );

  app.get("/agents/:id/versions/:a/diff/:b", async (c) => {
    const d = await agents.diff(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("a"),
      c.req.param("b"),
    );
    return d ? c.json(d) : fail(c, "NOT_FOUND");
  });

  app.delete("/agents/:id/draft", async (c) => {
    const r = await agents.discardDraft(c.get("principal"), c.req.param("id"));
    return r.ok ? c.body(null, 204) : fail(c, r.code);
  });

  app.get("/agents/:id/export", async (c) => {
    const bytes = await agents.export(c.get("principal"), c.req.param("id"), clientOf(c));
    if (!bytes) return fail(c, "NOT_FOUND");
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="agent.skill"',
    });
  });

  app.put("/agents/:id/schedule", limitBody, async (c) => {
    const body = await parse(c, Schedule);
    if (!body) return bad(c);
    const r = await agents.upsertSchedule(c.get("principal"), c.req.param("id"), body, clientOf(c));
    return r.ok ? c.json({ schedule: r.schedule }) : fail(c, r.code);
  });
  app.delete("/agents/:id/schedule", async (c) => {
    const r = await agents.deleteSchedule(c.get("principal"), c.req.param("id"), clientOf(c));
    return r.ok ? c.body(null, 204) : fail(c, r.code);
  });

  app.get("/agents/:id/activity", async (c) => {
    const p = c.get("principal");
    const found = await agents.get(p, c.req.param("id"));
    if (!found || !runs) return fail(c, "NOT_FOUND");
    const mine = (
      await runs.list(p, { kind: "agent", subject_id: found.agent.id, limit: 100 })
    ).filter((r) => r.started_by === p.userId);
    return c.json({ runs: mine, next_run_at: found.agent.schedule?.next_run_at ?? null });
  });

  app.post("/agents/:id/run", limitBody, async (c) => {
    if (!runs) return fail(c, "NOT_FOUND");
    const body = await parse(c, AgentRunBody);
    if (!body) return bad(c);
    const p = c.get("principal");
    const found = await agents.get(p, c.req.param("id"));
    if (!found) return fail(c, "NOT_FOUND");
    const versionId = body.version_id ?? found.agent.live_version_id;
    if (!versionId)
      return c.json({ code: "NOT_LIVE", message: "This agent isn't saved yet." }, 409);
    if (body.version_id && found.agent.my_access === "run") return fail(c, "FORBIDDEN");
    try {
      const started = await runs.start(p, {
        kind: "agent",
        subject_id: found.agent.id,
        agent_version_id: versionId,
        title: found.agent.title,
        ...(body.inputs ? { inputs: body.inputs } : {}),
        ...(body.thread_id ? { thread_id: body.thread_id } : {}),
        ...(body.matter_id ? { matter_id: body.matter_id } : {}),
        ...(body.space_id ? { space_id: body.space_id } : {}),
        path: body.thread_id ? "mention" : "page",
      });
      return c.json(started, 202);
    } catch (err) {
      if (err instanceof AgentRunError)
        return c.json({ code: err.code, message: err.message }, 403);
      throw err;
    }
  });

  // Test mode: a run bound to the draft version, kept out of usage counts (§3.4).
  app.post("/agents/:id/test", limitBody, async (c) => {
    if (!runs) return fail(c, "NOT_FOUND");
    const body = await parse(c, AgentRunBody);
    if (!body) return bad(c);
    const p = c.get("principal");
    const found = await agents.get(p, c.req.param("id"));
    if (!found) return fail(c, "NOT_FOUND");
    if (found.agent.my_access === "run") return fail(c, "FORBIDDEN");
    const versionId =
      body.version_id ?? found.agent.draft_version_id ?? found.agent.live_version_id;
    if (!versionId) return fail(c, "NO_DRAFT");
    const started = await runs.start(p, {
      kind: "agent",
      subject_id: found.agent.id,
      agent_version_id: versionId,
      title: `${found.agent.title} (test)`,
      ...(body.inputs ? { inputs: body.inputs } : {}),
      ...(body.thread_id ? { thread_id: body.thread_id } : {}),
      ...(body.matter_id ? { matter_id: body.matter_id } : {}),
      path: "page",
      test_mode: true,
    });
    return c.json(started, 202);
  });

  // The builder thread: describe the outcome; it asks up to five questions, then drafts.
  app.post("/agents/:id/builder", limitBody, async (c) => {
    if (!runs) return fail(c, "NOT_FOUND");
    const body = await parse(
      c,
      z.object({
        message: z.string().trim().min(1).max(5000),
        thread_id: AgentRunBody.shape.thread_id,
      }),
    );
    if (!body) return bad(c);
    const p = c.get("principal");
    const found = await agents.get(p, c.req.param("id"));
    if (!found) return fail(c, "NOT_FOUND");
    if (found.agent.my_access === "run" || found.agent.my_access === "view")
      return fail(c, "FORBIDDEN");
    const started = await runs.start(p, {
      kind: "agent_builder",
      subject_id: found.agent.id,
      title: found.agent.title,
      inputs: body.message,
      ...(body.thread_id ? { thread_id: body.thread_id } : {}),
      path: "page",
    });
    return c.json(started, 202);
  });

  // "Request changes" from the test tab: revises the draft; the editor hears of it by event.
  app.post("/agents/:id/test/request-changes", limitBody, async (c) => {
    if (!runs) return fail(c, "NOT_FOUND");
    const body = await parse(
      c,
      z.object({
        thread_id: AgentRunBody.shape.thread_id,
        request: z.string().trim().min(1).max(5000),
      }),
    );
    if (!body) return bad(c);
    const p = c.get("principal");
    const found = await agents.get(p, c.req.param("id"));
    if (!found) return fail(c, "NOT_FOUND");
    if (found.agent.my_access === "run" || found.agent.my_access === "view")
      return fail(c, "FORBIDDEN");
    const started = await runs.start(p, {
      kind: "agent_builder",
      subject_id: found.agent.id,
      title: found.agent.title,
      inputs: body.request,
      ...(body.thread_id ? { thread_id: body.thread_id } : {}),
      path: "page",
      test_mode: true,
      interactive: false,
    });
    return c.json({ run_id: started.run_id }, 202);
  });

  if (options.nudges) {
    const nudges = options.nudges;
    app.post("/agents/nudge", limitBody, async (c) => {
      const body = await parse(c, z.object({ prompt: z.string().max(2000) }));
      if (!body) return bad(c);
      return c.json({ nudge: await nudges.match(c.get("principal"), body.prompt) });
    });
    app.post("/agents/:id/nudge/dismiss", async (c) => {
      await nudges.dismiss(c.get("principal"), c.req.param("id"));
      return c.body(null, 204);
    });
  }

  // ---- sharing ----

  app.get("/agents/:id/shares", async (c) => {
    const r = await agents.shares(c.get("principal"), c.req.param("id"));
    if (r === "NOT_FOUND" || r === "FORBIDDEN") return fail(c, r);
    return c.json(r);
  });
  app.post("/agents/:id/shares", limitBody, async (c) => {
    const body = await parse(c, ShareRequestBody);
    if (!body) return bad(c);
    const r = await agents.share(c.get("principal"), c.req.param("id"), body, clientOf(c));
    if (!r.ok) return fail(c, r.code);
    return c.json({ outcome: r.outcome, id: r.id }, r.outcome === "granted" ? 201 : 202);
  });
  app.delete("/agents/:id/shares/:grant", async (c) => {
    const r = await agents.unshare(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("grant"),
      clientOf(c),
    );
    return r.ok ? c.body(null, 204) : fail(c, r.code);
  });

  // ---- approvals queue and configuration ----

  app.get("/admin/sharing/requests", async (c) => {
    const status = z
      .enum(["pending", "accepted", "denied"])
      .safeParse(c.req.query("filter[status]") ?? "pending");
    if (!status.success) return bad(c);
    const r = await agents.requests(c.get("principal"), status.data);
    return r
      ? c.json({ requests: r })
      : c.json({ code: "FORBIDDEN", message: "Admins only." }, 403);
  });
  for (const [path, accept] of [
    ["accept", true],
    ["deny", false],
  ] as const) {
    app.post(`/admin/sharing/requests/:id/${path}`, limitBody, async (c) => {
      const body = accept ? {} : await parse(c, ShareDecision);
      if (body === null) return bad(c);
      const r = await agents.decide(
        c.get("principal"),
        c.req.param("id"),
        accept,
        (body as { reason?: string }).reason,
        clientOf(c),
      );
      if (r === "ok") return c.body(null, 204);
      return r === "FORBIDDEN"
        ? c.json({ code: "FORBIDDEN", message: "You can't decide that request." }, 403)
        : c.json({ code: "NOT_FOUND", message: "That request wasn't found." }, 404);
    });
  }
  if (options.sharing) {
    const sharing = options.sharing;
    app.get("/admin/config/sharing", async (c) =>
      c.json({ require_approval: await sharing.get(c.get("principal")) }),
    );
    app.put("/admin/config/sharing", limitBody, async (c) => {
      const body = await parse(c, z.object({ require_approval: ApprovalConfig }));
      if (!body) return bad(c);
      const ok = await sharing.set(c.get("principal"), body.require_approval, clientOf(c));
      return ok
        ? c.json({ require_approval: body.require_approval })
        : c.json({ code: "FORBIDDEN", message: "Admins only." }, 403);
    });
  }

  return app;
}
