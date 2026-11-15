import {
  PlaybookCreate,
  PlaybookGrants,
  PlaybookPatch,
  PlaybookStatus,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { PlaybookFailure, Playbooks } from "./playbooks.js";

type Env = { Variables: { principal: Principal } };
type Status = 400 | 403 | 404 | 413 | 422 | 503;

const FAILURES: Record<PlaybookFailure, { status: Status; message: string }> = {
  NOT_FOUND: { status: 404, message: "That playbook or document wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that with this playbook." },
  RULE_LIMIT: { status: 422, message: "A playbook can hold up to 200 rules." },
  INVALID_PRINCIPAL: { status: 422, message: "Share only with people and groups here." },
  NO_PARSEABLE_INPUT: {
    status: 422,
    message: "No text could be read from that document. Pick one that has finished processing.",
  },
  DOC_TOO_LARGE: { status: 422, message: "That document is over 1,000,000 characters." },
  NO_RULES_FOUND: {
    status: 422,
    message: "No positions could be found in that document. Try another, or start from a template.",
  },
  MODEL_UNAVAILABLE: {
    status: 503,
    message: "No model could read the document. Try again shortly.",
  },
};

// The contract's refinements name these codes, so they reach the client as themselves.
const RULE_ERRORS = ["RULE_LIMIT", "DUPLICATE_RULE_TITLE"] as const;
const RULE_MESSAGES: Record<(typeof RULE_ERRORS)[number], string> = {
  RULE_LIMIT: FAILURES.RULE_LIMIT.message,
  DUPLICATE_RULE_TITLE: "Each rule needs its own title.",
};

const listQuery = z.object({
  status: PlaybookStatus.optional(),
  contract_type: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
});
const versionNo = z.coerce
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

export function playbookHttp(playbooks: Playbooks, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  // 200 rules of a few thousand characters each fit well inside this.
  const limitBody = bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });

  const fail = (c: Context, reason: PlaybookFailure) => {
    const failure = FAILURES[reason];
    return c.json({ code: reason, message: failure.message }, failure.status);
  };

  async function parse<T extends z.ZodType>(c: Context, schema: T) {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (parsed.success) return { data: parsed.data as z.output<T> };
    const messages = parsed.error.issues.map((i) => i.message);
    const code = RULE_ERRORS.find((e) => messages.includes(e));
    const response = code
      ? c.json({ code, message: RULE_MESSAGES[code] }, 422)
      : c.json(
          {
            code: "INVALID_REQUEST",
            message: "Check the playbook details.",
            details: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path, code: i.code })),
          },
          400,
        );
    return { response };
  }

  app.get("/playbooks", async (c) => {
    const query = listQuery.safeParse({
      status: c.req.query("filter[status]") ?? c.req.query("status"),
      contract_type: c.req.query("filter[contract_type]") ?? c.req.query("contract_type"),
      q: c.req.query("q") || undefined,
    });
    if (!query.success) {
      return c.json({ code: "INVALID_REQUEST", message: "Check the filters." }, 400);
    }
    const found = await playbooks.list(c.get("principal"), query.data);
    return c.json({ playbooks: found });
  });

  app.post("/playbooks", limitBody, async (c) => {
    const body = await parse(c, PlaybookCreate);
    if (!("data" in body)) return body.response;
    const result = await playbooks.create(c.get("principal"), body.data, clientOf(c));
    if (!result.ok) return fail(c, result.reason);
    return c.json(
      {
        playbook: result.playbook,
        ...(result.generation ? { generation: result.generation } : {}),
      },
      201,
    );
  });

  app.get("/playbooks/:id", async (c) => {
    const playbook = await playbooks.get(c.get("principal"), c.req.param("id"));
    return playbook ? c.json({ playbook }) : fail(c, "NOT_FOUND");
  });

  app.patch("/playbooks/:id", limitBody, async (c) => {
    const body = await parse(c, PlaybookPatch);
    if (!("data" in body)) return body.response;
    const result = await playbooks.update(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    return result.ok ? c.json({ playbook: result.playbook }) : fail(c, result.reason);
  });

  app.delete("/playbooks/:id", async (c) => {
    const result = await playbooks.remove(c.get("principal"), c.req.param("id"), clientOf(c));
    return result.ok ? c.body(null, 204) : fail(c, result.reason);
  });

  for (const [path, status] of [
    ["publish", "published"],
    ["unpublish", "unpublished"],
  ] as const) {
    app.post(`/playbooks/:id/${path}`, async (c) => {
      const result = await playbooks.setStatus(
        c.get("principal"),
        c.req.param("id"),
        status,
        clientOf(c),
      );
      return result.ok ? c.json({ playbook: result.playbook }) : fail(c, result.reason);
    });
  }

  app.get("/playbooks/:id/versions", async (c) => {
    const versions = await playbooks.versions(c.get("principal"), c.req.param("id"));
    return versions ? c.json({ versions }) : fail(c, "NOT_FOUND");
  });

  app.get("/playbooks/:id/versions/:no", async (c) => {
    const no = versionNo.safeParse(c.req.param("no"));
    if (!no.success) return fail(c, "NOT_FOUND");
    const playbook = await playbooks.version(c.get("principal"), c.req.param("id"), no.data);
    return playbook ? c.json({ playbook }) : fail(c, "NOT_FOUND");
  });

  app.get("/playbooks/:id/grants", async (c) => {
    const grants = await playbooks.grants(c.get("principal"), c.req.param("id"));
    return grants ? c.json({ grants }) : fail(c, "NOT_FOUND");
  });

  app.put("/playbooks/:id/grants", limitBody, async (c) => {
    const body = await parse(c, PlaybookGrants);
    if (!("data" in body)) return body.response;
    const result = await playbooks.setGrants(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    return result.ok ? c.json({ grants: result.grants }) : fail(c, result.reason);
  });

  return app;
}
