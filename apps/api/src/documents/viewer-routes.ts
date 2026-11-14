import { MAX_LAYOUT_PAGES } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Viewer } from "./viewer.js";

type Env = { Variables: { principal: Principal } };

const MAX_INT = 2 ** 31 - 1;
const pageRange = z
  .object({
    from: z.coerce.number().int().min(1).max(MAX_INT),
    to: z.coerce.number().int().min(1).max(MAX_INT),
  })
  .refine(({ from, to }) => to >= from && to - from < MAX_LAYOUT_PAGES);
const query = z
  .string()
  .min(1)
  .max(500)
  .refine((text) => !text.includes("\0"));

// One range only: pdf.js never asks for more, and multipart answers are a needless parser.
const RANGE = /^bytes=(\d{0,15})-(\d{0,15})$/;

export function parseRange(header: string | undefined, total: number) {
  const match = header ? RANGE.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // "bytes=-n" is the last n bytes.
    const last = Number(match[2]);
    return { start: Math.max(0, total - last), end: total - 1 };
  }
  return { start: Number(match[1]), end: match[2] === "" ? null : Number(match[2]) };
}

const notFound = (c: Context) =>
  c.json({ code: "NOT_FOUND", message: "That document wasn't found." }, 404);

export function viewerRoutes(viewer: Viewer, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();

  app.get("/:id/versions/:v/manifest", async (c) => {
    const found = await viewer.manifest(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("v"),
      clientOf(c),
    );
    return found ? c.json(found) : notFound(c);
  });

  app.get("/:id/versions/:v/pages", async (c) => {
    const parsed = pageRange.safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!parsed.success) {
      return c.json(
        { code: "INVALID_REQUEST", message: `Ask for 1 to ${MAX_LAYOUT_PAGES} pages.` },
        400,
      );
    }
    const found = await viewer.pages(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("v"),
      parsed.data.from,
      parsed.data.to,
    );
    if (!found) return notFound(c);
    if ("notReady" in found) {
      c.header("Retry-After", "5");
      return c.json(
        {
          code: "VERSION_NOT_READY",
          message: "This document is still being read.",
          status: found.notReady,
        },
        409,
      );
    }
    return c.json({ pages: found });
  });

  app.get("/:id/versions/:v/file", async (c) => {
    const found = await viewer.file(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("v"),
      (total) => parseRange(c.req.header("range"), total),
    );
    if (!found) return notFound(c);
    c.header("Accept-Ranges", "bytes");
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if ("unsatisfiable" in found) {
      c.header("Content-Range", `bytes */${found.unsatisfiable}`);
      return c.body(null, 416);
    }
    c.header("Content-Type", found.mime);
    c.header("Content-Disposition", "inline");
    c.header("Content-Length", String(found.bytes.length));
    const body = found.bytes as Uint8Array<ArrayBuffer>;
    if (!found.partial) return c.body(body, 200);
    c.header("Content-Range", `bytes ${found.start}-${found.end}/${found.total}`);
    return c.body(body, 206);
  });

  app.get("/:id/versions/:v/search", async (c) => {
    const parsed = query.safeParse(c.req.query("q"));
    if (!parsed.success) {
      return c.json({ code: "INVALID_REQUEST", message: "Check the search terms." }, 400);
    }
    const hits = await viewer.search(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("v"),
      parsed.data,
    );
    return hits ? c.json({ hits }) : notFound(c);
  });

  return app;
}
