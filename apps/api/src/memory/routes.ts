import {
  AcceptCandidate,
  ImportCommit,
  MEMORY_LIMITS,
  MemoryInput,
  MemorySettingsPatch,
  MemorySource,
  PersonaliseInput,
  StyleInstructions,
  StyleName,
  StylePatch,
  StyleShare,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Memories, MemoryFailure, Result } from "./memory.js";
import type { StyleFailure, WritingStyles } from "./styles.js";

type Env = { Variables: { principal: Principal } };

const MEMORY_FAILURES: Record<
  MemoryFailure,
  { status: 400 | 403 | 404 | 409 | 503; message: string }
> = {
  NOT_ENABLED: { status: 403, message: "Memory isn't enabled for your role." },
  NOT_FOUND: { status: 404, message: "That memory wasn't found." },
  LIMIT_MEMORIES: {
    status: 409,
    message: "You've reached 1,000 memories. Delete or merge some to add more.",
  },
  LIMIT_MEMORY_LENGTH: { status: 400, message: "A memory can be up to 1,000 characters." },
  DUPLICATE: { status: 409, message: "You already have that memory." },
  MODEL_UNAVAILABLE: { status: 503, message: "No model could answer just now. Try again shortly." },
  IMPORT_INVALID: {
    status: 400,
    message: "Upload a UTF-8 CSV with a header that includes a text column, up to 5,000 rows.",
  },
};

const STYLE_FAILURES: Record<
  StyleFailure,
  { status: 400 | 403 | 404 | 409 | 422; message: string }
> = {
  NOT_FOUND: { status: 404, message: "That writing style wasn't found." },
  FORBIDDEN: { status: 403, message: "You can't change this writing style." },
  SHARE_FORBIDDEN: {
    status: 403,
    message: "Sharing writing styles with the workspace needs the writing_styles.share permission.",
  },
  DUPLICATE_NAME: { status: 409, message: "You already have a writing style with that name." },
  LIMIT_STYLES: { status: 409, message: "You can keep up to 50 writing styles." },
  LIMIT_STYLE_SAMPLE: {
    status: 400,
    message: "A sample can be up to 20 pages and 50,000 characters.",
  },
  STYLE_SAMPLE_UNREADABLE: { status: 422, message: "That sample has no text we could read." },
  INSTRUCTIONS_REQUIRED: {
    status: 400,
    message: "Give either typed instructions or a sample file, not both.",
  },
};

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => invalid(c) });
const IMPORT_BYTES = 2 * 1024 * 1024;
const SAMPLE_BYTES = 10 * 1024 * 1024;
const importUpload = bodyLimit({
  maxSize: IMPORT_BYTES + 64 * 1024,
  onError: (c) =>
    c.json({ code: "IMPORT_INVALID", message: MEMORY_FAILURES.IMPORT_INVALID.message }, 400),
});
const sampleUpload = bodyLimit({
  maxSize: SAMPLE_BYTES + 64 * 1024,
  onError: (c) =>
    c.json({ code: "LIMIT_STYLE_SAMPLE", message: STYLE_FAILURES.LIMIT_STYLE_SAMPLE.message }, 400),
});

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  source: MemorySource.optional(),
});
const id = z.uuid();

const memoryJson = (m: object) => m;

export function memoryRoutes(memories: Memories, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();

  const respond = <T>(
    c: Context<Env>,
    result: Result<T>,
    json: (v: T) => object,
    status: 200 | 201 = 200,
  ) => {
    if (!result.ok) {
      const failure = MEMORY_FAILURES[result.reason];
      return c.json({ code: result.reason, message: failure.message }, failure.status);
    }
    return c.json(json(result.value), status);
  };
  const noContent = (c: Context<Env>, result: Result<unknown>) =>
    result.ok ? c.body(null, 204) : respond(c, result, () => ({}));

  const idParam = (c: Context<Env>) => {
    const parsed = id.safeParse(c.req.param("id"));
    return parsed.success ? parsed.data : null;
  };

  app.get("/memory/settings", async (c) => {
    const s = await memories.settings(c.get("principal"));
    return c.json({
      use_memory: s.useMemory,
      permitted: s.permitted,
      pending_candidates: s.pendingCandidates,
    });
  });
  app.patch("/memory/settings", small, async (c) => {
    const body = MemorySettingsPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await memories.setUse(c.get("principal"), body.data.use_memory, clientOf(c));
    return respond(c, result, (s) => ({
      use_memory: s.useMemory,
      permitted: s.permitted,
      pending_candidates: s.pendingCandidates,
    }));
  });

  app.get("/memory/candidates", async (c) => {
    const result = await memories.candidates(c.get("principal"));
    return respond(c, result, (items) => ({ items }));
  });
  app.post("/memory/candidates/:id/accept", small, async (c) => {
    const cid = idParam(c);
    const body = AcceptCandidate.safeParse(await c.req.json().catch(() => ({})));
    if (!cid || !body.success) return invalid(c);
    const result = await memories.accept(c.get("principal"), cid, body.data.text, clientOf(c));
    return respond(c, result, memoryJson);
  });
  app.post("/memory/candidates/:id/dismiss", async (c) => {
    const cid = idParam(c);
    if (!cid) return invalid(c);
    return noContent(c, await memories.dismiss(c.get("principal"), cid, clientOf(c)));
  });

  app.post("/memory/personalise", small, async (c) => {
    const body = PersonaliseInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await memories.personalise(c.get("principal"), body.data);
    return respond(c, result, (texts) => ({ proposals: texts.map((text) => ({ text })) }));
  });

  app.post("/memory/import/parse", importUpload, async (c) => {
    const type = c.req.header("content-type") ?? "";
    let bytes: Uint8Array | null = null;
    if (type.startsWith("text/csv")) {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    } else {
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.file;
      if (file instanceof File) bytes = new Uint8Array(await file.arrayBuffer());
    }
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > IMPORT_BYTES) {
      return c.json(
        { code: "IMPORT_INVALID", message: MEMORY_FAILURES.IMPORT_INVALID.message },
        400,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return c.json(
        { code: "IMPORT_INVALID", message: MEMORY_FAILURES.IMPORT_INVALID.message },
        400,
      );
    }
    const result = await memories.parseImport(c.get("principal"), text);
    return respond(c, result, (parsed) => ({
      import_id: parsed.importId,
      rows: parsed.rows,
      would_exceed_cap: parsed.wouldExceedCap,
    }));
  });
  app.post(
    "/memory/import/:id/commit",
    bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => invalid(c) }),
    async (c) => {
      const iid = idParam(c);
      const body = ImportCommit.safeParse(await c.req.json().catch(() => null));
      if (!iid || !body.success) return invalid(c);
      const result = await memories.commitImport(
        c.get("principal"),
        iid,
        body.data.rows,
        clientOf(c),
      );
      return respond(c, result, (r) => r);
    },
  );

  app.get("/memory/export", async (c) => {
    const result = await memories.exportCsv(c.get("principal"), clientOf(c));
    if (!result.ok) return respond(c, result, () => ({}));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="memories.csv"');
    return c.body(result.value);
  });

  // What shaped one answer: a row exists for the person who asked, and no one else.
  app.get("/memory/use/:id", async (c) => {
    const mid = idParam(c);
    if (!mid) return invalid(c);
    const use = await memories.use(c.get("principal"), mid);
    return use ? c.json(use) : c.json({ code: "NOT_FOUND", message: "Nothing was recorded." }, 404);
  });

  app.get("/memory", async (c) => {
    const query = listQuery.safeParse({ q: c.req.query("q"), source: c.req.query("source") });
    if (!query.success) return invalid(c);
    const result = await memories.list(c.get("principal"), {
      ...(query.data.q ? { q: query.data.q } : {}),
      ...(query.data.source ? { source: query.data.source } : {}),
    });
    return respond(c, result, (l) => ({
      items: l.items,
      count: l.count,
      limit: MEMORY_LIMITS.perUser,
      enabled: l.enabled,
    }));
  });
  app.post("/memory", small, async (c) => {
    const body = MemoryInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    return respond(
      c,
      await memories.create(c.get("principal"), body.data.text, clientOf(c)),
      memoryJson,
      201,
    );
  });
  app.patch("/memory/:id", small, async (c) => {
    const mid = idParam(c);
    const body = MemoryInput.safeParse(await c.req.json().catch(() => null));
    if (!mid || !body.success) return invalid(c);
    return respond(
      c,
      await memories.update(c.get("principal"), mid, body.data.text, clientOf(c)),
      memoryJson,
    );
  });
  app.delete("/memory/:id", async (c) => {
    const mid = idParam(c);
    if (!mid) return invalid(c);
    return noContent(c, await memories.remove(c.get("principal"), mid, clientOf(c)));
  });
  app.delete("/memory", async (c) => {
    // Deleting everything is deliberate: the client must say so.
    if (c.req.header("x-confirm") !== "all") {
      return c.json(
        { code: "CONFIRMATION_REQUIRED", message: "Send X-Confirm: all to delete every memory." },
        400,
      );
    }
    return noContent(c, await memories.removeAll(c.get("principal"), clientOf(c)));
  });

  return app;
}

export function styleRoutes(styles: WritingStyles, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();

  const respond = <T>(
    c: Context<Env>,
    result: { ok: true; value: T } | { ok: false; reason: StyleFailure },
    status: 200 | 201 = 200,
  ) => {
    if (!result.ok) {
      const failure = STYLE_FAILURES[result.reason];
      return c.json({ code: result.reason, message: failure.message }, failure.status);
    }
    return c.json(result.value as object, status);
  };
  const idParam = (c: Context<Env>) => {
    const parsed = id.safeParse(c.req.param("id"));
    return parsed.success ? parsed.data : null;
  };
  const notFound = (c: Context) =>
    c.json({ code: "NOT_FOUND", message: STYLE_FAILURES.NOT_FOUND.message }, 404);

  app.get("/writing-styles", async (c) => c.json(await styles.list(c.get("principal"))));

  // Multipart (name, instructions or a sample file) or JSON (name, instructions).
  app.post("/writing-styles", sampleUpload, async (c) => {
    const type = c.req.header("content-type") ?? "";
    let fields: Record<string, unknown> | null;
    let sample: { name: string; bytes: Uint8Array } | undefined;
    if (type.startsWith("application/json")) {
      fields = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    } else {
      const form = await c.req.parseBody().catch(() => null);
      fields = form;
      const file = form?.sample;
      if (file instanceof File) {
        if (file.size > SAMPLE_BYTES) {
          return c.json(
            { code: "LIMIT_STYLE_SAMPLE", message: STYLE_FAILURES.LIMIT_STYLE_SAMPLE.message },
            400,
          );
        }
        sample = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      }
    }
    const name = StyleName.safeParse(fields?.name);
    const raw = fields?.instructions;
    const instructions =
      raw === undefined || raw === ""
        ? { success: true as const, data: undefined }
        : StyleInstructions.safeParse(raw);
    if (!name.success || !instructions.success) return invalid(c);
    return respond(
      c,
      await styles.create(
        c.get("principal"),
        { name: name.data, instructions: instructions.data, sample },
        clientOf(c),
      ),
      201,
    );
  });

  app.get("/writing-styles/:id", async (c) => {
    const sid = idParam(c);
    if (!sid) return invalid(c);
    const style = await styles.get(c.get("principal"), sid);
    return style ? c.json(style) : notFound(c);
  });
  app.patch("/writing-styles/:id", small, async (c) => {
    const sid = idParam(c);
    const body = StylePatch.safeParse(await c.req.json().catch(() => null));
    if (!sid || !body.success) return invalid(c);
    return respond(c, await styles.update(c.get("principal"), sid, body.data, clientOf(c)));
  });
  app.delete("/writing-styles/:id", async (c) => {
    const sid = idParam(c);
    if (!sid) return invalid(c);
    const result = await styles.remove(c.get("principal"), sid, clientOf(c));
    return result.ok ? c.body(null, 204) : respond(c, result);
  });
  app.post("/writing-styles/:id/share", small, async (c) => {
    const sid = idParam(c);
    const body = StyleShare.safeParse(await c.req.json().catch(() => null));
    if (!sid || !body.success) return invalid(c);
    const result = await styles.share(c.get("principal"), sid, body.data.shared, clientOf(c));
    if (!result.ok) return respond(c, result);
    // Taking back someone else's style leaves nothing the admin may read.
    return result.value ? c.json(result.value) : c.body(null, 204);
  });

  return app;
}
