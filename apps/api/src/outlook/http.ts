import { OUTLOOK_LIMITS, OutlookDraft, OutlookItem } from "@legallabs/contracts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { createLimiter } from "../auth/limiter.js";
import type { Attached, Outlook, OutlookFailure } from "./outlook.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<OutlookFailure, { status: 400 | 403 | 404 | 409; message: string }> = {
  FORBIDDEN: { status: 403, message: "You don't have permission to do that." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
  MATTER_REQUIRED: { status: 400, message: "Choose the matter you're working on first." },
  NOT_STORED: { status: 400, message: "This email couldn't be stored." },
  NOT_FOUND: { status: 404, message: "That answer wasn't found." },
  COPY_DISABLED: {
    status: 403,
    message: "A source of this thread is in a vault that doesn't allow copies.",
  },
  TOO_LONG: { status: 400, message: "This is too long for a reply. Ask for a shorter draft." },
  VAULT_NOT_FOUND: { status: 404, message: "That vault or folder wasn't found." },
  VAULT_READ_ONLY: { status: 409, message: "That vault is synced, so files can't be added." },
  VAULT_FULL: { status: 409, message: "The vault can't hold any more files." },
};

// The body text may be four bytes a character, and a multipart body wraps each part.
const MAX_BODY = OUTLOOK_LIMITS.totalBytes + OUTLOOK_LIMITS.bodyChars * 4 + 1024 * 1024;
// Each request holds its files in memory.
const MAX_CONCURRENT = 2;

const itemJson = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "not JSON" });
    return z.NEVER;
  }
});

const saveTarget = z.object({ vault_id: z.uuid(), folder_id: z.uuid().optional() });

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the email sent." }, 400);

/** The fields an email arrives in, or null when they are not one email within the limits. */
async function readEmail(c: Context) {
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form) return null;
  const item = itemJson.pipe(OutlookItem).safeParse(form.item);
  const sent = [form.attachment ?? []].flat();
  if (!item.success || !sent.every((f) => f instanceof File)) return null;
  const files = sent as File[];
  if (
    files.length > OUTLOOK_LIMITS.attachments ||
    files.some((f) => f.size > OUTLOOK_LIMITS.fileBytes) ||
    files.reduce((n, f) => n + f.size, 0) > OUTLOOK_LIMITS.totalBytes
  ) {
    return null;
  }
  const attachments: Attached[] = [];
  for (const f of files) {
    attachments.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return { item: item.data, attachments, form };
}

export function outlookHttp(outlook: Outlook, clientOf: (c: Context) => Client, now: () => number) {
  // Each email is many files to store and read.
  const perUser = createLimiter({ limit: 20, windowMs: 10 * 60_000, now });
  const app = new Hono<Env>();
  let busy = 0;

  // Before the body is read, so waiting requests can't pile up in memory.
  const limit: MiddlewareHandler<Env> = async (c, next) => {
    const wait = perUser.take(c.get("principal").userId);
    if (wait > 0 || busy >= MAX_CONCURRENT) {
      c.header("Retry-After", String(wait || 5));
      return c.json(
        { code: "TOO_MANY_REQUESTS", message: "Too many emails just now. Try again shortly." },
        429,
      );
    }
    busy++;
    try {
      await next();
    } finally {
      busy--;
    }
  };
  const limitBody = bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => c.json({ code: "FILE_TOO_LARGE", message: "That email is too large." }, 413),
  });

  const refuse = (c: Context, reason: OutlookFailure) => {
    const { status, message } = FAILURES[reason];
    return c.json({ code: reason, message }, status);
  };

  app.post("/items", limit, limitBody, async (c) => {
    const read = await readEmail(c);
    const matter = z.uuid().optional().safeParse(read?.form.matter_id);
    if (!read || !matter.success) return invalid(c);
    const result = await outlook.ingest(
      c.get("principal"),
      { item: read.item, matterId: matter.data ?? null, attachments: read.attachments },
      clientOf(c),
    );
    return result.ok ? c.json(result.value, 201) : refuse(c, result.reason);
  });

  const small = bodyLimit({ maxSize: 4096, onError: (c) => invalid(c) });
  app.post("/drafts", small, async (c) => {
    const parsed = OutlookDraft.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const result = await outlook.replyDraft(c.get("principal"), parsed.data, clientOf(c));
    return result.ok ? c.json(result.value) : refuse(c, result.reason);
  });

  app.post("/save-to-vault", limit, limitBody, async (c) => {
    const read = await readEmail(c);
    const target = saveTarget.safeParse(read?.form);
    if (!read || !target.success) return invalid(c);
    const result = await outlook.saveToVault(
      c.get("principal"),
      {
        item: read.item,
        attachments: read.attachments,
        vaultId: target.data.vault_id,
        folderId: target.data.folder_id ?? null,
      },
      clientOf(c),
    );
    return result.ok ? c.json(result.value, 201) : refuse(c, result.reason);
  });

  return app;
}
