import { isSourceId, type SourceId } from "@legallabs/knowledge";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Principal } from "../auth/auth.js";
import {
  type AuthorityDetail,
  type FilterPreset,
  type Knowledge,
  MAX_PASSAGES,
  type Passage,
  type PresetResult,
  parseFilter,
  type SourceDetail,
  type SourceSummary,
} from "./knowledge.js";

type Env = { Variables: { principal: Principal } };

/** The picker allows this many sources at once (KNW-001). */
export const MAX_SOURCES = 5;

const fail = (c: Context, status: 400 | 403 | 404 | 409, code: string, message: string) =>
  c.json({ code, message }, status);

const forbidden = (c: Context) =>
  fail(c, 403, "FORBIDDEN", "You don't have permission to use knowledge sources.");
const noSource = (c: Context) => fail(c, 404, "SOURCE_NOT_FOUND", "That source wasn't found.");
const noAuthority = (c: Context) =>
  fail(c, 404, "AUTHORITY_NOT_FOUND", "That authority wasn't found.");

const noNul = (text: string) => !text.includes("\0");
const authorityRef = z.string().min(3).max(300).refine(noNul);

const searchQuery = z.object({
  q: z.string().min(1).max(500).refine(noNul),
  sources: z.array(z.string()).min(1),
  filters: z.string().max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PASSAGES).optional(),
});

const resolveBody = z.strictObject({
  citation_string: z.string().min(1).max(500).refine(noNul),
  pin: z.string().min(1).max(100).refine(noNul).optional(),
  quote: z.string().min(1).max(4000).refine(noNul).optional(),
  source_hint: z.string().max(40).optional(),
});

const presetName = z.string().trim().min(1).max(80).refine(noNul);
// Capped well under the table's limit, so an oversized filter is a 400, not a database error.
const filterValue = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 4000, "filter too large");
const createPresetBody = z.strictObject({
  name: presetName,
  filter: filterValue,
  default: z.boolean().optional(),
});
const updatePresetBody = z.strictObject({
  name: presetName.optional(),
  filter: filterValue.optional(),
  default: z.boolean().optional(),
});

const summaryJson = (s: SourceSummary) => ({
  id: s.id,
  name: s.name,
  group: s.group,
  mode: s.mode,
  jurisdiction: s.jurisdiction,
  terms_url: s.termsUrl,
  attribution: s.attribution,
  doc_count: s.docCount,
  last_refresh_at: s.lastRefreshAt,
  health: s.health,
});

const detailJson = (s: SourceDetail) => ({
  ...summaryJson(s),
  filter_schema: s.filterSchema,
  facets: {
    courts: s.facets.courts,
    doc_types: s.facets.docTypes,
    jurisdictions: s.facets.jurisdictions,
  },
});

const passageJson = (p: Passage) => ({
  chunk_id: p.chunkId,
  authority_ref: p.authorityRef,
  source_id: p.source,
  title: p.title,
  citation: p.citation,
  court: p.court,
  doc_type: p.docType,
  date: p.date,
  section_path: p.sectionPath,
  url: p.url,
  text: p.text,
});

const authorityJson = (a: AuthorityDetail) => ({
  ref: a.ref,
  source_id: a.source,
  title: a.title,
  court: a.court,
  jurisdiction: a.jurisdiction,
  doc_type: a.docType,
  date: a.date,
  url: a.url,
  citation_strings: a.citationStrings,
  first_page: a.firstPage,
  last_page: a.lastPage,
  sections: a.sections,
  meta: a.meta,
  attribution: a.attribution,
});

const presetJson = (p: FilterPreset) => ({
  id: p.id,
  source_id: p.sourceId,
  name: p.name,
  filter: p.filter,
  default: p.isDefault,
  created_at: p.createdAt,
});

const PRESET_FAILURES = {
  FORBIDDEN: [403, "You don't have permission to use knowledge sources."],
  NOT_FOUND: [404, "That saved filter wasn't found."],
  NAME_TAKEN: [409, "You already have a saved filter with that name."],
  INVALID_FILTER: [400, "That filter doesn't fit this source."],
  TOO_MANY: [409, "You can save at most 50 filters per source."],
} as const;

function presetReply(c: Context, result: PresetResult, status: 200 | 201) {
  if (result.ok) return c.json({ filter: presetJson(result.preset) }, status);
  const [code, message] = PRESET_FAILURES[result.reason];
  return fail(c, code, result.reason, message);
}

export function knowledgeRoutes(knowledge: Knowledge) {
  const app = new Hono<Env>();
  const json = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => fail(c, 400, "INVALID_REQUEST", "The request is too large."),
  });

  app.get("/sources", async (c) => {
    const found = await knowledge.sources(c.get("principal"));
    if (found === null) return forbidden(c);
    return c.json({ items: found.map(summaryJson) });
  });

  app.get("/sources/:id", async (c) => {
    const found = await knowledge.source(c.get("principal"), c.req.param("id"));
    if (found === null) return noSource(c);
    return c.json(detailJson(found));
  });

  app.get("/search", async (c) => {
    const parsed = searchQuery.safeParse({
      q: c.req.query("q"),
      sources: c.req.queries("source") ?? [],
      filters: c.req.query("filters"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", "Check the search terms.");
    const { q, sources, filters, limit } = parsed.data;
    const ids = [...new Set(sources)];
    if (ids.length > MAX_SOURCES) {
      return fail(c, 400, "TOO_MANY_SOURCES", `${MAX_SOURCES} sources maximum.`);
    }
    if (!ids.every(isSourceId)) return noSource(c);
    let byId: Record<string, unknown> = {};
    if (filters !== undefined) {
      try {
        byId = filterValue.parse(JSON.parse(filters));
      } catch {
        return fail(c, 400, "INVALID_FILTER", "Filters must be a JSON object keyed by source.");
      }
    }
    const picked = ids.map((sourceId: SourceId) => ({ sourceId, filter: byId[sourceId] ?? {} }));
    // Checked here, so a null from search can only mean the caller may not use sources.
    const stray = Object.keys(byId).find((id) => !ids.includes(id as SourceId));
    const bad = stray ?? picked.find((p) => parseFilter(p.sourceId, p.filter) === null)?.sourceId;
    if (bad !== undefined) {
      return fail(c, 400, "INVALID_FILTER", `That filter doesn't fit ${bad}.`);
    }
    const passages = await knowledge.search(c.get("principal"), q, picked, limit);
    if (passages === null) return forbidden(c);
    return c.json({ passages: passages.map(passageJson) });
  });

  app.get("/authorities/:ref", async (c) => {
    const ref = authorityRef.safeParse(c.req.param("ref"));
    const found = ref.success ? await knowledge.authority(c.get("principal"), ref.data) : null;
    if (found === null) return noAuthority(c);
    return c.json(authorityJson(found));
  });

  app.get("/authorities/:ref/text", async (c) => {
    const ref = authorityRef.safeParse(c.req.param("ref"));
    const cursor = z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .safeParse(c.req.query("cursor") ?? 0);
    if (!ref.success || !cursor.success) {
      return fail(c, 400, "INVALID_REQUEST", "Check the authority and cursor.");
    }
    const page = await knowledge.text(c.get("principal"), ref.data, cursor.data);
    if (page === null) return noAuthority(c);
    return c.json({
      chunks: page.chunks.map((chunk) => ({
        id: chunk.id,
        ordinal: chunk.ordinal,
        section_path: chunk.sectionPath,
        text: chunk.text,
      })),
      next_cursor: page.nextCursor,
    });
  });

  app.post("/citations/resolve", json, async (c) => {
    const parsed = resolveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", "Send a citation string.");
    const { citation_string, pin, quote, source_hint } = parsed.data;
    if (source_hint !== undefined && !isSourceId(source_hint)) return noSource(c);
    const result = await knowledge.resolve(c.get("principal"), {
      citation: citation_string,
      ...(pin === undefined ? {} : { pin }),
      ...(quote === undefined ? {} : { quote }),
      ...(source_hint === undefined ? {} : { sourceHint: source_hint }),
    });
    if (result === null) return forbidden(c);
    return c.json({
      status: result.status,
      reason: result.reason ?? null,
      authority_ref: result.authorityRef ?? null,
      // Null for anything unresolved: a reader is never sent to a guess.
      href: result.href ?? null,
      candidates: (result.candidates ?? []).map((candidate) => ({
        authority_ref: candidate.authorityRef,
        title: candidate.title,
        citation_string: candidate.citation,
      })),
      located: result.located
        ? {
            chunk_id: result.located.chunkId,
            char_from: result.located.from,
            char_to: result.located.to,
          }
        : null,
    });
  });

  app.get("/sources/:id/filters", async (c) => {
    const id = c.req.param("id");
    if (!isSourceId(id)) return noSource(c);
    const found = await knowledge.presets(c.get("principal"), id);
    if (found === null) return forbidden(c);
    return c.json({ items: found.map(presetJson) });
  });

  app.post("/sources/:id/filters", json, async (c) => {
    const id = c.req.param("id");
    if (!isSourceId(id)) return noSource(c);
    const parsed = createPresetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", "Send a name and a filter.");
    const result = await knowledge.createPreset(c.get("principal"), id, {
      name: parsed.data.name,
      filter: parsed.data.filter,
      isDefault: parsed.data.default ?? false,
    });
    return presetReply(c, result, 201);
  });

  app.patch("/filters/:id", json, async (c) => {
    const parsed = updatePresetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", "Check the saved filter.");
    const { name, filter } = parsed.data;
    const result = await knowledge.updatePreset(c.get("principal"), c.req.param("id"), {
      ...(name === undefined ? {} : { name }),
      ...(filter === undefined ? {} : { filter }),
      ...(parsed.data.default === undefined ? {} : { isDefault: parsed.data.default }),
    });
    return presetReply(c, result, 200);
  });

  app.delete("/filters/:id", async (c) => {
    const deleted = await knowledge.deletePreset(c.get("principal"), c.req.param("id"));
    if (deleted === null) return forbidden(c);
    if (!deleted) return fail(c, 404, "NOT_FOUND", "That saved filter wasn't found.");
    return c.body(null, 204);
  });

  return app;
}
