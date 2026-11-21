import { AGENT_LIMITS, type FileKind, type ImportIssue, SkillManifest } from "@legallabs/contracts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type BundleFailure =
  | "SKILL_NO_INSTRUCTIONS"
  | "SKILL_MANIFEST_INVALID"
  | "SKILL_UNSAFE_ARCHIVE"
  | "SKILL_TOO_LARGE"
  | "SKILL_UNREADABLE"
  | "AGENT_INSTRUCTIONS_TOO_LONG";

export interface BundleFile {
  label: string;
  name: string;
  bytes: Uint8Array;
  status: "ok" | "too_large" | "unsupported";
}

export interface BundleRef {
  label: string;
  kind: FileKind;
  ref: string;
  name: string;
  /** Whether the id resolves here; one from another deployment doesn't. */
  resolved: boolean;
}

export interface BundleSource {
  label: string;
  kind: "knowledge_source" | "connector" | "scan";
  source: string;
  filters?: Record<string, unknown> | undefined;
  status: "ok" | "unknown_source" | "not_enabled";
}

export interface BundlePreview {
  title: string;
  description: string;
  practice_areas: string[];
  instructions: string;
  files: BundleFile[];
  refs: BundleRef[];
  sources: BundleSource[];
  issues: ImportIssue[];
}

export type BundleResult =
  | { ok: true; preview: BundlePreview }
  | { ok: false; code: BundleFailure; issues?: { path: (string | number)[]; message: string }[] };

export interface BundleOptions {
  sourceStatus: (source: string) => BundleSource["status"];
  /** Whether a vault, table or playbook id from the bundle exists for this person. */
  refResolves: (kind: FileKind, ref: string) => boolean;
  maxFileBytes?: number;
}

const ARCHIVES = /\.(zip|skill|tar|tgz|gz|7z|rar|bz2|xz)$/i;
const ALLOWED = /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|html?|rtf|json)$/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** A path inside the bundle, or null if it would leave it. */
export function safePath(path: string): string | null {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);

/** YAML frontmatter, as far as bundles use it: scalars and `[a, b]` lists. */
export function parseFrontmatter(source: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!m) return { meta: {}, body: source };
  const meta: Record<string, unknown> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as string;
    const raw = (kv[2] ?? "").trim();
    const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, "$2");
    if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else if (/^\d+$/.test(raw)) {
      meta[key] = Number(raw);
    } else {
      meta[key] = unquote(raw);
    }
  }
  return { meta, body: source.slice(m[0].length) };
}

const asString = (v: unknown) => (typeof v === "string" ? v : undefined);

export function readBundle(
  bytes: Uint8Array,
  filename: string,
  options: BundleOptions,
): BundleResult {
  const maxFile = options.maxFileBytes ?? MAX_FILE_BYTES;
  const issues: ImportIssue[] = [];

  if (!isZip(bytes)) {
    if (bytes.byteLength > AGENT_LIMITS.markdownBytes)
      return { ok: false, code: "SKILL_TOO_LARGE" };
    if (!/\.md$/i.test(filename) && !/\.markdown$/i.test(filename)) {
      return { ok: false, code: "SKILL_UNREADABLE" };
    }
    const { meta, body } = parseFrontmatter(strFromU8(bytes));
    return finish(
      {
        name: asString(meta.name) ?? filename.replace(/\.[^.]+$/, ""),
        description: asString(meta.description) ?? "",
        practice_areas: Array.isArray(meta.practice_areas) ? (meta.practice_areas as string[]) : [],
        instructions: body.trim(),
        attachments: [],
        sources: [],
      },
      new Map(),
      options,
      issues,
    );
  }

  if (bytes.byteLength > AGENT_LIMITS.bundleBytes) return { ok: false, code: "SKILL_TOO_LARGE" };
  let entries: Record<string, Uint8Array>;
  try {
    // Unpacked in memory only: nothing is ever written to a path the archive names.
    entries = unzipSync(bytes, { filter: (f) => !f.name.endsWith("/") });
  } catch {
    return { ok: false, code: "SKILL_UNREADABLE" };
  }

  const names = Object.keys(entries);
  const cleaned = new Map<string, Uint8Array>();
  for (const name of names) {
    const path = safePath(name);
    if (!path) return { ok: false, code: "SKILL_UNSAFE_ARCHIVE" };
    cleaned.set(path, entries[name] as Uint8Array);
  }
  // A single top folder (the `<bundle>/` of the layout) is stripped.
  const tops = new Set([...cleaned.keys()].map((p) => p.split("/")[0]));
  const strip = tops.size === 1 && [...cleaned.keys()].every((p) => p.includes("/"));
  const files = new Map<string, Uint8Array>();
  for (const [p, data] of cleaned) files.set(strip ? p.split("/").slice(1).join("/") : p, data);

  const embedded = [...files].filter(([p]) => p.startsWith("files/"));
  if (embedded.length > AGENT_LIMITS.bundleFiles) return { ok: false, code: "SKILL_TOO_LARGE" };
  for (const [p, data] of files) {
    if (ARCHIVES.test(p) || (p.startsWith("files/") && isZip(data))) {
      return { ok: false, code: "SKILL_UNSAFE_ARCHIVE" };
    }
  }

  let manifest: SkillManifest | null = null;
  const rawManifest = files.get("manifest.json");
  if (rawManifest) {
    let json: unknown;
    try {
      json = JSON.parse(strFromU8(rawManifest));
    } catch {
      return { ok: false, code: "SKILL_MANIFEST_INVALID" };
    }
    const parsed = SkillManifest.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        code: "SKILL_MANIFEST_INVALID",
        issues: parsed.error.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path as (string | number)[], message: i.message })),
      };
    }
    manifest = parsed.data;
  }

  const instructionsPath = safePath(manifest?.instructions_path ?? "SKILL.md");
  if (!instructionsPath) return { ok: false, code: "SKILL_UNSAFE_ARCHIVE" };
  const raw = files.get(instructionsPath) ?? files.get("SKILL.md");
  if (!raw) return { ok: false, code: "SKILL_NO_INSTRUCTIONS" };
  const { meta, body } = parseFrontmatter(strFromU8(raw));

  const uploads = new Map<string, Uint8Array>();
  for (const [p, data] of embedded) uploads.set(p.slice("files/".length), data);

  return finish(
    {
      name: manifest?.name ?? asString(meta.name) ?? filename.replace(/\.[^.]+$/, ""),
      description: manifest?.description ?? asString(meta.description) ?? "",
      practice_areas:
        manifest?.practice_areas ??
        (Array.isArray(meta.practice_areas) ? (meta.practice_areas as string[]) : []),
      instructions: body.trim(),
      attachments: manifest?.attachments ?? [],
      sources: manifest?.sources ?? [],
    },
    uploads,
    { ...options, maxFileBytes: maxFile },
    issues,
  );
}

interface Parsed {
  name: string;
  description: string;
  practice_areas: string[];
  instructions: string;
  attachments: SkillManifest["attachments"];
  sources: SkillManifest["sources"];
}

function finish(
  p: Parsed,
  uploads: Map<string, Uint8Array>,
  options: BundleOptions,
  issues: ImportIssue[],
): BundleResult {
  if (p.instructions.length === 0) return { ok: false, code: "SKILL_NO_INSTRUCTIONS" };
  if (p.instructions.length > AGENT_LIMITS.instructions) {
    return { ok: false, code: "AGENT_INSTRUCTIONS_TOO_LONG" };
  }
  const maxFile = options.maxFileBytes ?? MAX_FILE_BYTES;
  const files: BundleFile[] = [];
  const refs: BundleRef[] = [];
  for (const a of p.attachments) {
    if (a.kind === "upload") {
      const path = a.path ? safePath(a.path) : null;
      const data = path ? uploads.get(path.replace(/^files\//, "")) : undefined;
      if (!path || !data) {
        issues.push({
          kind: "attachment",
          label: a.label,
          status: "unsupported",
          detail: "file missing",
        });
        continue;
      }
      const name = path.split("/").pop() as string;
      const status =
        data.byteLength > maxFile ? "too_large" : ALLOWED.test(name) ? "ok" : "unsupported";
      files.push({ label: a.label, name, bytes: data, status });
      issues.push({ kind: "file", label: a.label, status });
    } else if (a.ref) {
      const resolved = options.refResolves(a.kind, a.ref);
      refs.push({ label: a.label, kind: a.kind, ref: a.ref, name: a.name ?? a.label, resolved });
      issues.push({
        kind: "attachment",
        label: a.label,
        status: resolved ? "ok" : "unknown_source",
      });
    }
  }
  const sources: BundleSource[] = p.sources.map((s) => {
    const status = options.sourceStatus(s.source);
    issues.push({ kind: "source", label: s.label, status });
    return { label: s.label, kind: s.kind, source: s.source, filters: s.filters, status };
  });
  return {
    ok: true,
    preview: {
      title: p.name.slice(0, AGENT_LIMITS.title),
      description: p.description.slice(0, AGENT_LIMITS.description),
      practice_areas: p.practice_areas.slice(0, AGENT_LIMITS.practiceAreas),
      instructions: p.instructions,
      files,
      refs,
      sources,
      issues,
    },
  };
}

export interface ExportInput {
  title: string;
  description: string;
  practice_areas: string[];
  instructions: string;
  attachments: { label: string; kind: FileKind; ref: string; name: string }[];
  sources: {
    label: string;
    kind: "knowledge_source" | "connector" | "scan";
    source: string;
    filters?: Record<string, unknown> | undefined;
  }[];
  uploads: Map<string, { name: string; bytes: Uint8Array }>;
  origin: { exported_from: string; agent_id: string; version: number };
}

/** The bundle format: SKILL.md, manifest.json and files/. Other attachments export as a ref and a name. */
export function writeBundle(x: ExportInput): Uint8Array {
  const manifest = {
    schema: "counsel.skill/1",
    name: x.title,
    description: x.description,
    practice_areas: x.practice_areas,
    instructions_path: "SKILL.md",
    attachments: x.attachments.map((a) => {
      const upload = a.kind === "upload" ? x.uploads.get(a.label) : undefined;
      return a.kind === "upload" && upload
        ? { label: a.label, kind: a.kind, path: `files/${upload.name}`, name: a.name }
        : { label: a.label, kind: a.kind, ref: a.ref, name: a.name };
    }),
    sources: x.sources,
    defaults: { response_mode: "auto", deep_analysis: false },
    origin: x.origin,
  };
  const entries: Record<string, Uint8Array> = {
    "SKILL.md": strToU8(
      `---\nname: ${JSON.stringify(x.title)}\ndescription: ${JSON.stringify(x.description)}\n---\n${x.instructions}\n`,
    ),
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const u of x.uploads.values()) entries[`files/${u.name}`] = u.bytes;
  return zipSync(entries);
}
