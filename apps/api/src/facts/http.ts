import {
  EntityCreate,
  EntityPatch,
  FactCreate,
  FactDate,
  FactExtractRequest,
  FactPatch,
  FactStatus,
  FactStatusRequest,
  IssueCreate,
  IssuePatch,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Limiter } from "../auth/limiter.js";
import type { FactExtractions } from "./extraction.js";
import type { FactFailure, FactResult, Facts } from "./facts.js";

type Env = { Variables: { principal: Principal } };

export const FACT_FAILURES: Record<
  FactFailure,
  { status: 400 | 403 | 404 | 409 | 422 | 429; message: string }
> = {
  NOT_FOUND: { status: 404, message: "That Space or fact wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  INVALID: { status: 400, message: "Check the request." },
  DOCUMENT_NOT_FOUND: {
    status: 404,
    message: "That file isn't in this Space's vaults, or you can't open it.",
  },
  QUOTE_NOT_FOUND: {
    status: 422,
    message: "Those words aren't on that page. Select the text as the document has it.",
  },
  UNKNOWN_ENTITY: { status: 422, message: "That person or organisation wasn't found." },
  UNKNOWN_ISSUE: { status: 422, message: "That issue wasn't found." },
  TOO_MANY_DOCUMENTS: {
    status: 422,
    message: "Choose 200 files or fewer for one extraction.",
  },
  TOO_MANY_RUNS: {
    status: 409,
    message: "Three extractions are already running. Wait for one to finish.",
  },
  TOO_MANY_REQUESTS: { status: 429, message: "You've asked a lot just now. Try again shortly." },
  BAD_CURSOR: { status: 400, message: "Check the request." },
};

export const FactFilterQuery = z.object({
  entity_id: z.uuid().optional(),
  issue_id: z.uuid().optional(),
  document_id: z.uuid().optional(),
  status: FactStatus.optional(),
  from: FactDate.optional(),
  to: FactDate.optional(),
  cursor: z.string().max(100).optional(),
});

const BASE = "/apps/chronology/spaces/:space";

export function factHttp(
  facts: Facts,
  clientOf: (c: Context) => Client,
  extraction?: FactExtractions,
  asks?: Limiter,
) {
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });

  const invalid = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the request." }, 400);
  const answer = <T>(
    c: Context,
    result: FactResult<T>,
    key: string | null,
    status: 200 | 201 = 200,
  ) => {
    if (!result.ok) {
      const failure = FACT_FAILURES[result.reason];
      return c.json({ code: result.reason, message: failure.message }, failure.status);
    }
    return c.json(key ? { [key]: result.value } : (result.value as object), status);
  };
  const body = async <T extends z.ZodType>(c: Context, schema: T) =>
    schema.safeParse(await c.req.json().catch(() => null)) as z.ZodSafeParseResult<z.output<T>>;
  const me = (c: Context<Env>) => c.get("principal");
  const param = (c: Context, name: string) => c.req.param(name) ?? "";

  app.get(`${BASE}/facts`, async (c) => {
    const q = c.req.query();
    const parsed = FactFilterQuery.safeParse({
      entity_id: q["filter[entity_id]"],
      issue_id: q["filter[issue_id]"],
      document_id: q["filter[document_id]"],
      status: q["filter[status]"],
      from: q["filter[from]"],
      to: q["filter[to]"],
      cursor: q.cursor,
    });
    if (!parsed.success) return invalid(c);
    const f = parsed.data;
    return answer(
      c,
      await facts.list(me(c), param(c, "space"), {
        entityId: f.entity_id,
        issueId: f.issue_id,
        documentId: f.document_id,
        status: f.status,
        from: f.from,
        to: f.to,
        cursor: f.cursor,
      }),
      null,
    );
  });

  app.post(`${BASE}/facts`, limitBody, async (c) => {
    const parsed = await body(c, FactCreate);
    if (!parsed.success) return invalid(c);
    return answer(
      c,
      await facts.create(me(c), param(c, "space"), parsed.data, clientOf(c)),
      "fact",
      201,
    );
  });

  app.get(`${BASE}/facts/audit`, async (c) =>
    answer(c, await facts.audit(me(c), param(c, "space"), c.req.query("cursor")), null),
  );

  if (extraction) {
    // Cancelled like any run, at POST /runs/:id/cancel.
    app.post(`${BASE}/facts/extract`, limitBody, async (c) => {
      const parsed = await body(c, FactExtractRequest);
      if (!parsed.success) return invalid(c);
      const charge = (n: number) => {
        let wait = 0;
        for (let i = 0; i < n && wait === 0; i++) wait = asks?.take(me(c).userId) ?? 0;
        return wait;
      };
      const result = await extraction.extract(
        me(c),
        param(c, "space"),
        parsed.data,
        charge,
        clientOf(c),
      );
      if (!result.ok) return answer(c, result, null);
      return c.json(result.value, 202);
    });

    app.get(`${BASE}/facts/extractions`, async (c) =>
      answer(c, await extraction.list(me(c), param(c, "space")), "extractions"),
    );

    app.get(`${BASE}/facts/extractions/:run`, async (c) =>
      answer(c, await extraction.get(me(c), param(c, "space"), param(c, "run")), "extraction"),
    );
  }

  app.get(`${BASE}/facts/:id`, async (c) =>
    answer(c, await facts.get(me(c), param(c, "space"), param(c, "id")), "fact"),
  );

  app.patch(`${BASE}/facts/:id`, limitBody, async (c) => {
    const parsed = await body(c, FactPatch);
    if (!parsed.success) return invalid(c);
    return answer(
      c,
      await facts.patch(me(c), param(c, "space"), param(c, "id"), parsed.data, clientOf(c)),
      "fact",
    );
  });

  app.post(`${BASE}/facts/:id/status`, limitBody, async (c) => {
    const parsed = await body(c, FactStatusRequest);
    if (!parsed.success) return invalid(c);
    const { status } = parsed.data;
    return answer(
      c,
      await facts.setStatus(me(c), param(c, "space"), param(c, "id"), status, clientOf(c)),
      "fact",
    );
  });

  app.get(`${BASE}/facts/:id/versions`, async (c) =>
    answer(c, await facts.versions(me(c), param(c, "space"), param(c, "id")), "versions"),
  );

  app.get(`${BASE}/entities`, async (c) =>
    answer(c, await facts.entities(me(c), param(c, "space")), "entities"),
  );

  app.post(`${BASE}/entities`, limitBody, async (c) => {
    const parsed = await body(c, EntityCreate);
    if (!parsed.success) return invalid(c);
    return answer(
      c,
      await facts.createEntity(me(c), param(c, "space"), parsed.data, clientOf(c)),
      "entity",
      201,
    );
  });

  app.patch(`${BASE}/entities/:id`, limitBody, async (c) => {
    const parsed = await body(c, EntityPatch);
    if (!parsed.success) return invalid(c);
    return answer(
      c,
      await facts.patchEntity(me(c), param(c, "space"), param(c, "id"), parsed.data, clientOf(c)),
      "entity",
    );
  });

  app.get(`${BASE}/issues`, async (c) =>
    answer(c, await facts.issues(me(c), param(c, "space")), "issues"),
  );

  app.post(`${BASE}/issues`, limitBody, async (c) => {
    const parsed = await body(c, IssueCreate);
    if (!parsed.success) return invalid(c);
    return answer(
      c,
      await facts.createIssue(me(c), param(c, "space"), parsed.data, clientOf(c)),
      "issue",
      201,
    );
  });

  app.patch(`${BASE}/issues/:id`, limitBody, async (c) => {
    const parsed = await body(c, IssuePatch);
    if (!parsed.success) return invalid(c);
    return answer(
      c,
      await facts.patchIssue(me(c), param(c, "space"), param(c, "id"), parsed.data, clientOf(c)),
      "issue",
    );
  });

  return app;
}
