import {
  ExportFormat,
  LIBRARY_LIMITS,
  LibraryGrant,
  PromptInput,
  TemplateFields,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type {
  Library,
  LibraryFailure,
  LibraryKind,
  PromptView,
  Result,
  ShareView,
  TemplateView,
  VersionView,
} from "./library.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<LibraryFailure, { status: 400 | 403 | 404 | 413; message: string }> = {
  NOT_FOUND: { status: 404, message: "That item wasn't found." },
  FORBIDDEN: { status: 403, message: "You can't change this item." },
  SHARING_RESTRICTED: {
    status: 403,
    message: "Only Library managers can share with everyone in the workspace.",
  },
  NOT_MEMBER: { status: 400, message: "Library items can be shared with members only." },
  INVALID_GRANTS: { status: 400, message: "Check who you're sharing with." },
  NOT_DOCX: { status: 400, message: "Upload a Word document or template (.docx or .dotx)." },
  MACROS: { status: 400, message: "Templates with macros can't be used. Save it without macros." },
  STRICT: { status: 400, message: "Save the template as a standard Word document, not Strict." },
  TOO_LARGE: { status: 413, message: "A template can be up to 10 MB." },
};

// Room for the form around the file.
const MAX_UPLOAD = LIBRARY_LIMITS.templateBytes + 64 * 1024;
const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => invalid(c) });
const upload = bodyLimit({
  maxSize: MAX_UPLOAD,
  onError: (c) => c.json({ code: "TOO_LARGE", message: FAILURES.TOO_LARGE.message }, 413),
});

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
const notFound = (c: Context) =>
  c.json({ code: "NOT_FOUND", message: FAILURES.NOT_FOUND.message }, 404);

const promptPatch = PromptInput.partial().strict();
const templatePatch = TemplateFields.partial().strict();
const sharesBody = z.object({ grants: z.array(LibraryGrant).max(LIBRARY_LIMITS.grants) }).strict();
const defaultBody = z.object({ on: z.boolean() }).strict();
const versionNo = z.coerce.number().int().min(1).max(100_000);
const fileName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\p{C}/\\]+$/u);
const note = z
  .string()
  .trim()
  .max(500)
  .refine((t) => !t.includes("\0"));

const promptJson = (p: PromptView) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  text: p.text,
  variables: p.variables,
  owner: p.owner,
  access: p.access,
  shared: p.shared,
  updated_at: p.updatedAt,
});

const versionJson = (v: VersionView) => ({
  no: v.no,
  file_name: v.fileName,
  size: v.size,
  placeholders: v.placeholders,
  note: v.note,
  reverted_from: v.revertedFrom,
  created_by: v.createdBy,
  created_at: v.createdAt,
});

const templateJson = (t: TemplateView) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  instructions: t.instructions,
  is_default: t.isDefault,
  owner: t.owner,
  access: t.access,
  shared: t.shared,
  current: versionJson(t.current),
  updated_at: t.updatedAt,
});

const shareJson = (s: ShareView) => ({
  principal_type: s.principalType,
  principal_id: s.principalId,
  label: s.label,
  level: s.level,
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOTX = "application/vnd.openxmlformats-officedocument.wordprocessingml.template";

/** Sends a file for download; the name is only ever in the encoded parameter. */
export function download(c: Context, bytes: Uint8Array, filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  c.header("Content-Type", ext === "pdf" ? "application/pdf" : ext === "dotx" ? DOTX : DOCX);
  c.header(
    "Content-Disposition",
    `attachment; filename="download.${ext ?? "bin"}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return c.body(bytes.slice().buffer as ArrayBuffer);
}

export function libraryRoutes(library: Library, clientOf: (c: Context) => Client) {
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

  const readFile = async (c: Context<Env>) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File) || !fileName.safeParse(file.name).success) return null;
    return { form, file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } };
  };

  app.get("/abilities", async (c) => {
    const a = await library.abilities(c.get("principal"));
    return c.json({ manage: a.manage, draft: a.draft });
  });

  app.get("/principals", async (c) => {
    const q = z.string().trim().min(2).max(100).safeParse(c.req.query("q"));
    if (!q.success) return invalid(c);
    const found = await library.findPrincipals(c.get("principal"), q.data);
    return c.json({
      principals: found.map((p) => ({
        principal_type: p.principalType,
        principal_id: p.principalId,
        label: p.label,
      })),
    });
  });

  app.get("/prompts", async (c) =>
    c.json({ prompts: (await library.listPrompts(c.get("principal"))).map(promptJson) }),
  );
  app.post("/prompts", small, async (c) => {
    const body = PromptInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await library.createPrompt(c.get("principal"), body.data, clientOf(c));
    return respond(c, result, (p) => ({ prompt: promptJson(p) }), 201);
  });
  app.get("/prompts/:id", async (c) => {
    const p = await library.getPrompt(c.get("principal"), c.req.param("id"));
    return p ? c.json({ prompt: promptJson(p) }) : notFound(c);
  });
  app.patch("/prompts/:id", small, async (c) => {
    const body = promptPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await library.updatePrompt(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    return respond(c, result, (p) => ({ prompt: promptJson(p) }));
  });
  app.delete("/prompts/:id", async (c) => {
    const result = await library.deletePrompt(c.get("principal"), c.req.param("id"), clientOf(c));
    return result.ok ? c.body(null, 204) : respond(c, result, () => ({}));
  });

  app.get("/templates", async (c) =>
    c.json({ templates: (await library.listTemplates(c.get("principal"))).map(templateJson) }),
  );
  app.post("/templates", upload, async (c) => {
    const read = await readFile(c);
    if (!read) return invalid(c);
    const field = (name: string) => {
      const value = read.form?.[name];
      return typeof value === "string" && value.trim() ? value : undefined;
    };
    const fields = TemplateFields.safeParse({
      name: field("name") ?? read.file.name.replace(/\.(docx|dotx)$/i, ""),
      description: field("description"),
      instructions: field("instructions"),
    });
    if (!fields.success) return invalid(c);
    const result = await library.createTemplate(
      c.get("principal"),
      fields.data,
      read.file,
      clientOf(c),
    );
    return respond(c, result, (t) => ({ template: templateJson(t) }), 201);
  });
  app.get("/templates/:id", async (c) => {
    const found = await library.getTemplate(c.get("principal"), c.req.param("id"));
    return found
      ? c.json({
          template: templateJson(found.template),
          versions: found.versions.map(versionJson),
        })
      : notFound(c);
  });
  app.patch("/templates/:id", small, async (c) => {
    const body = templatePatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await library.updateTemplate(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    return respond(c, result, (t) => ({ template: templateJson(t) }));
  });
  app.delete("/templates/:id", async (c) => {
    const result = await library.deleteTemplate(c.get("principal"), c.req.param("id"), clientOf(c));
    return result.ok ? c.body(null, 204) : respond(c, result, () => ({}));
  });
  app.post("/templates/:id/versions", upload, async (c) => {
    const read = await readFile(c);
    const raw = read?.form?.note;
    const parsed = note.safeParse(typeof raw === "string" ? raw : "");
    if (!read || !parsed.success) return invalid(c);
    const result = await library.addVersion(
      c.get("principal"),
      c.req.param("id"),
      read.file,
      parsed.data || null,
      clientOf(c),
    );
    return respond(c, result, (t) => ({ template: templateJson(t) }), 201);
  });
  app.post("/templates/:id/versions/:no/revert", async (c) => {
    const no = versionNo.safeParse(c.req.param("no"));
    if (!no.success) return invalid(c);
    const result = await library.revert(
      c.get("principal"),
      c.req.param("id"),
      no.data,
      clientOf(c),
    );
    return respond(c, result, (t) => ({ template: templateJson(t) }), 201);
  });
  app.get("/templates/:id/versions/:no/file", async (c) => {
    const no = versionNo.safeParse(c.req.param("no"));
    if (!no.success) return invalid(c);
    const file = await library.file(c.get("principal"), c.req.param("id"), no.data);
    return file ? download(c, file.bytes, file.name) : notFound(c);
  });
  app.put("/templates/:id/default", small, async (c) => {
    const body = defaultBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await library.setDefault(
      c.get("principal"),
      c.req.param("id"),
      body.data.on,
      clientOf(c),
    );
    return respond(c, result, (t) => ({ template: templateJson(t) }));
  });
  app.get("/templates/:id/sample", async (c) => {
    const format = ExportFormat.safeParse(c.req.query("format") ?? "docx");
    if (!format.success) return invalid(c);
    const file = await library.sample(
      c.get("principal"),
      c.req.param("id"),
      format.data,
      clientOf(c),
    );
    return file ? download(c, file.bytes, file.filename) : notFound(c);
  });

  for (const kind of ["prompt", "template"] as const satisfies readonly LibraryKind[]) {
    app.get(`/${kind}s/:id/shares`, async (c) => {
      const shares = await library.shares(c.get("principal"), kind, c.req.param("id"));
      return shares ? c.json({ shares: shares.map(shareJson) }) : notFound(c);
    });
    app.put(`/${kind}s/:id/shares`, small, async (c) => {
      const body = sharesBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return invalid(c);
      const result = await library.setShares(
        c.get("principal"),
        kind,
        c.req.param("id"),
        body.data.grants,
        clientOf(c),
      );
      return respond(c, result, (shares) => ({ shares: shares.map(shareJson) }));
    });
  }

  return app;
}
