import { badRequest, ScimError } from "./errors.js";
import { equalityTerms, type Filter, matches, parseFilter } from "./filter.js";
import {
  type AttrDef,
  extensionAttrs,
  findAttr,
  knownUrn,
  PATCH_URN,
  type ResourceDef,
} from "./schemas.js";

// RFC 7644 section 3.5.2, with the habits of Entra ID (capitalised op names, "True"/"False"
// strings, path-less objects whose keys are paths) and Okta (path-less replace, full objects).

type Doc = Record<string, unknown>;

export interface PatchOp {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

export interface PatchPath {
  urn?: string;
  attr?: string;
  filter?: Filter;
  sub?: string;
}

const NAME = /^[A-Za-z$][A-Za-z0-9_$-]*$/;
const MAX_TEXT = 4096;
const MAX_OPS = 200;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function closingBracket(text: string, open: number): number {
  let inString = false;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "]") return i;
  }
  return -1;
}

export function parsePatchPath(raw: string): PatchPath {
  const text = raw.trim();
  const whole = knownUrn(text);
  if (whole) return { urn: whole };
  const open = text.indexOf("[");
  const head = open >= 0 ? text.slice(0, open) : text;
  let urn: string | undefined;
  let attrPart = head;
  const colon = head.lastIndexOf(":");
  if (colon >= 0) {
    urn = knownUrn(head.slice(0, colon));
    if (!urn) throw badRequest("invalidPath", `Unknown schema in path: ${raw}`);
    attrPart = head.slice(colon + 1);
  }
  const [attr, subFromDot, extra] = attrPart.split(".");
  if (!attr || !NAME.test(attr) || extra !== undefined) {
    throw badRequest("invalidPath", `Bad path: ${raw}`);
  }
  if (open < 0) {
    if (subFromDot !== undefined && !NAME.test(subFromDot)) {
      throw badRequest("invalidPath", `Bad path: ${raw}`);
    }
    return { ...(urn ? { urn } : {}), attr, ...(subFromDot ? { sub: subFromDot } : {}) };
  }
  if (subFromDot !== undefined) throw badRequest("invalidPath", `Bad path: ${raw}`);
  const close = closingBracket(text, open);
  if (close < 0) throw badRequest("invalidPath", `Unclosed filter in path: ${raw}`);
  let filter: Filter;
  try {
    filter = parseFilter(text.slice(open + 1, close));
  } catch (err) {
    if (err instanceof ScimError) throw badRequest("invalidPath", `Bad filter in path: ${raw}`);
    throw err;
  }
  const after = text.slice(close + 1);
  let sub: string | undefined;
  if (after.length > 0) {
    if (!after.startsWith(".") || !NAME.test(after.slice(1))) {
      throw badRequest("invalidPath", `Bad path: ${raw}`);
    }
    sub = after.slice(1);
  }
  return { ...(urn ? { urn } : {}), attr, filter, ...(sub ? { sub } : {}) };
}

function key(obj: Doc, name: string): string | undefined {
  return Object.keys(obj).find((k) => same(k, name));
}

function checkText(value: string) {
  if (value.length > MAX_TEXT) throw badRequest("invalidValue", "A value is too long.");
  if (value.includes("\0")) throw badRequest("invalidValue", "A value holds a NUL byte.");
  return value;
}

/** Brings one value to the attribute's type; "True" and "False" become booleans. */
export function coerce(attr: AttrDef, value: unknown, forceSingle = false): unknown {
  if (attr.multi && !forceSingle) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((v) => coerce(attr, v, true));
  }
  switch (attr.type) {
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) {
        return value.toLowerCase() === "true";
      }
      throw badRequest("invalidValue", `${attr.name} must be true or false.`);
    }
    case "integer":
      if (typeof value === "number" && Number.isInteger(value)) return value;
      throw badRequest("invalidValue", `${attr.name} must be a whole number.`);
    case "complex": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw badRequest("invalidValue", `${attr.name} must be an object.`);
      }
      const out: Doc = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = findAttr(attr.sub ?? [], k);
        if (!sub || sub.readOnly || v === null || v === undefined) continue;
        out[sub.name] = coerce(sub, v);
      }
      return out;
    }
    default:
      if (typeof value !== "string") {
        throw badRequest("invalidValue", `${attr.name} must be text.`);
      }
      return checkText(value);
  }
}

function equalJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only one entry of a multi-valued attribute may be primary. */
function settlePrimary(items: Doc[], winner?: Doc) {
  const flagged = items.filter((i) => i.primary === true);
  if (flagged.length < 2) return;
  const keep = winner && flagged.includes(winner) ? winner : flagged[flagged.length - 1];
  for (const i of flagged) if (i !== keep) i.primary = false;
}

interface Target {
  obj: Doc;
  attrs: AttrDef[];
  urn?: string;
}

function resolveTarget(
  def: ResourceDef,
  doc: Doc,
  urn: string | undefined,
  create: boolean,
): Target {
  if (!urn || same(urn, def.core.id)) return { obj: doc, attrs: def.core.attributes };
  const attrs = extensionAttrs(def, urn);
  if (!attrs) throw badRequest("invalidPath", `${urn} does not apply to a ${def.name}.`);
  const existing = key(doc, urn);
  if (existing !== undefined) return { obj: doc[existing] as Doc, attrs, urn };
  const fresh: Doc = {};
  if (create) doc[urn] = fresh;
  return { obj: fresh, attrs, urn };
}

function dropEmptyExtension(doc: Doc, urn: string | undefined) {
  if (!urn) return;
  const k = key(doc, urn);
  if (k !== undefined && Object.keys(doc[k] as Doc).length === 0) delete doc[k];
}

function applyAt(
  def: ResourceDef,
  doc: Doc,
  verb: "add" | "replace" | "remove",
  path: PatchPath,
  value: unknown,
) {
  // A bare schema URN addresses a whole extension.
  if (path.attr === undefined) {
    const urn = path.urn ?? "";
    if (verb === "remove") {
      const k = key(doc, urn);
      if (k !== undefined) delete doc[k];
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw badRequest("invalidValue", "An extension takes an object.");
    }
    for (const [k, v] of Object.entries(value)) {
      applyAt(def, doc, verb, { urn, attr: k }, v);
    }
    return;
  }

  const { obj, attrs, urn } = resolveTarget(def, doc, path.urn, verb !== "remove");
  const attr = findAttr(attrs, path.attr);
  if (!attr) throw badRequest("invalidPath", `Unknown attribute ${path.attr}.`);
  if (attr.readOnly) throw badRequest("mutability", `${attr.name} is read-only.`);
  const existingKey = key(obj, attr.name);
  const current = existingKey === undefined ? undefined : obj[existingKey];
  const set = (v: unknown) => {
    if (existingKey !== undefined && existingKey !== attr.name) delete obj[existingKey];
    obj[attr.name] = v;
  };
  const unset = () => {
    if (existingKey !== undefined) delete obj[existingKey];
  };
  const finish = () => dropEmptyExtension(doc, urn);

  if (path.filter) {
    if (!attr.multi) throw badRequest("invalidPath", `${attr.name} does not take a filter.`);
    const subDef = path.sub ? findAttr(attr.sub ?? [], path.sub) : undefined;
    if (path.sub && !subDef) throw badRequest("invalidPath", `Unknown sub-attribute ${path.sub}.`);
    if (subDef?.readOnly || (subDef?.immutable && verb !== "remove")) {
      throw badRequest("mutability", `${attr.name}.${subDef.name} cannot be changed.`);
    }
    const items = (Array.isArray(current) ? current : []) as Doc[];
    const hit = items.filter((el) => typeof el === "object" && matches(path.filter as Filter, el));

    if (verb === "remove") {
      if (path.sub) {
        for (const el of hit) {
          const k = key(el, path.sub);
          if (k !== undefined) delete el[k];
        }
        const left = items.filter((el) => Object.keys(el).length > 0);
        if (left.length > 0) set(left);
        else unset();
      } else {
        const left = items.filter((el) => !hit.includes(el));
        if (left.length > 0) set(left);
        else unset();
      }
      return finish();
    }

    const change = (el: Doc) => {
      if (subDef) el[subDef.name] = coerce(subDef, value);
      else {
        const next = coerce(
          { ...attr, multi: false },
          typeof value === "object" ? value : { value },
        );
        if (verb === "replace") for (const k of Object.keys(el)) delete el[k];
        Object.assign(el, next);
      }
    };
    if (hit.length === 0) {
      if (verb === "replace") {
        throw badRequest("noTarget", `No ${attr.name} entry matches the filter.`);
      }
      const terms = equalityTerms(path.filter);
      if (!terms) throw badRequest("noTarget", `No ${attr.name} entry matches the filter.`);
      const fresh: Doc = {};
      for (const [k, v] of Object.entries(terms)) {
        const s = findAttr(attr.sub ?? [], k);
        if (s && v !== null) fresh[s.name] = coerce(s, v);
      }
      change(fresh);
      items.push(fresh);
      settlePrimary(items, fresh);
      set(items);
      return finish();
    }
    for (const el of hit) change(el);
    settlePrimary(items, hit[hit.length - 1]);
    set(items);
    return finish();
  }

  if (path.sub) {
    const subDef = findAttr(attr.sub ?? [], path.sub);
    if (attr.type !== "complex" || !subDef) {
      throw badRequest("invalidPath", `${attr.name} has no sub-attribute ${path.sub}.`);
    }
    if (subDef.readOnly || (subDef.immutable && verb !== "remove")) {
      throw badRequest("mutability", `${attr.name}.${subDef.name} cannot be changed.`);
    }
    if (verb === "remove" || ((value === null || value === undefined) && verb === "replace")) {
      for (const el of (attr.multi ? (current as Doc[] | undefined) : [current as Doc]) ?? []) {
        if (typeof el !== "object" || el === null) continue;
        const k = key(el, subDef.name);
        if (k !== undefined) delete el[k];
      }
      if (attr.multi) {
        const left = ((current as Doc[] | undefined) ?? []).filter(
          (e) => Object.keys(e).length > 0,
        );
        if (left.length > 0) set(left);
        else unset();
      } else if (current && Object.keys(current as Doc).length === 0) unset();
      return finish();
    }
    if (value === null || value === undefined) return;
    const coerced = coerce(subDef, value);
    if (attr.multi) {
      const items = (Array.isArray(current) ? current : [{}]) as Doc[];
      for (const el of items) el[subDef.name] = coerced;
      set(items);
    } else {
      set({ ...((current as Doc | undefined) ?? {}), [subDef.name]: coerced });
    }
    return finish();
  }

  // Whole attribute.
  if (verb === "remove") {
    if (attr.required) throw badRequest("mutability", `${attr.name} is required.`);
    // Entra removes named members with a value; without one, everything goes.
    if (attr.multi && Array.isArray(value) && value.length > 0 && Array.isArray(current)) {
      const gone = (el: Doc) =>
        value.some(
          (v) =>
            equalJson(v, el) ||
            (typeof v === "object" && v !== null && "value" in v && (v as Doc).value === el.value),
        );
      const left = (current as Doc[]).filter((el) => !gone(el));
      if (left.length > 0) set(left);
      else unset();
      return finish();
    }
    unset();
    return finish();
  }
  if (value === null || value === undefined) {
    if (verb === "replace") {
      if (attr.required) throw badRequest("invalidValue", `${attr.name} is required.`);
      unset();
      return finish();
    }
    return;
  }
  const coerced = coerce(attr, value);
  if (attr.multi) {
    const incoming = coerced as Doc[];
    if (verb === "replace") {
      settlePrimary(incoming);
      set(incoming);
    } else {
      const items = (Array.isArray(current) ? current : []) as Doc[];
      for (const el of incoming) {
        if (!items.some((have) => equalJson(have, el))) items.push(el);
      }
      settlePrimary(items, incoming[incoming.length - 1]);
      set(items);
    }
  } else if (attr.type === "complex" && verb === "add" && current) {
    set({ ...(current as Doc), ...(coerced as Doc) });
  } else {
    set(coerced);
  }
  finish();
}

/** Keys the provider may echo back in a path-less body: ignored, not errors. */
const ECHOED = new Set(["schemas", "id", "meta", "groups"]);

function applyOperation(def: ResourceDef, doc: Doc, raw: PatchOp) {
  const name = typeof raw.op === "string" ? raw.op.trim().toLowerCase() : "";
  if (name !== "add" && name !== "replace" && name !== "remove") {
    throw badRequest("invalidSyntax", `Unknown patch operation "${String(raw.op)}".`);
  }
  if (raw.path !== undefined && typeof raw.path !== "string") {
    throw badRequest("invalidPath", "path must be text.");
  }
  if (raw.path === undefined || raw.path === "") {
    if (name === "remove") throw badRequest("noTarget", "remove needs a path.");
    if (typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) {
      throw badRequest("invalidValue", "An operation without a path takes an object value.");
    }
    for (const [k, v] of Object.entries(raw.value)) {
      if (ECHOED.has(k.toLowerCase())) continue;
      applyAt(def, doc, name, parsePatchPath(k), v);
    }
    return;
  }
  applyAt(def, doc, name, parsePatchPath(raw.path), raw.value);
}

/** Applies every operation to a copy: all of them, or none. */
export function applyPatch(def: ResourceDef, doc: Doc, body: unknown): Doc {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("invalidSyntax", "A patch request is a JSON object.");
  }
  const { schemas, Operations, operations } = body as Doc & { operations?: unknown };
  if (
    !Array.isArray(schemas) ||
    !schemas.some((s) => typeof s === "string" && same(s, PATCH_URN))
  ) {
    throw badRequest("invalidSyntax", `schemas must include ${PATCH_URN}.`);
  }
  const ops = Operations ?? operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw badRequest("invalidSyntax", "Operations must be a non-empty array.");
  }
  if (ops.length > MAX_OPS) throw badRequest("invalidValue", "Too many operations.");
  const copy = structuredClone(doc);
  for (const op of ops) {
    if (typeof op !== "object" || op === null) {
      throw badRequest("invalidSyntax", "Each operation is an object.");
    }
    applyOperation(def, copy, op as PatchOp);
  }
  return copy;
}

/** A POST or PUT body, reduced to the attributes a client may write. */
export function normalizeBody(def: ResourceDef, body: unknown): Doc {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("invalidSyntax", "The body must be a JSON object.");
  }
  const out: Doc = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    const urn = knownUrn(k);
    if (urn) {
      if (same(urn, def.core.id)) continue;
      const attrs = extensionAttrs(def, urn);
      if (!attrs) continue;
      if (typeof v !== "object" || Array.isArray(v)) {
        throw badRequest("invalidValue", `${urn} must be an object.`);
      }
      const ext: Doc = {};
      for (const [ek, ev] of Object.entries(v)) {
        const a = findAttr(attrs, ek);
        if (a && !a.readOnly && ev !== null && ev !== undefined) ext[a.name] = coerce(a, ev);
      }
      if (Object.keys(ext).length > 0) out[urn] = ext;
      continue;
    }
    // Unknown and read-only attributes are ignored, as RFC 7643 section 2 allows.
    const attr = findAttr(def.core.attributes, k);
    if (!attr || attr.readOnly) continue;
    out[attr.name] = coerce(attr, v);
  }
  for (const a of def.core.attributes) {
    if (a.required && (typeof out[a.name] !== "string" || out[a.name] === "")) {
      throw badRequest("invalidValue", `${a.name} is required.`);
    }
    if (a.multi && Array.isArray(out[a.name])) settlePrimary(out[a.name] as Doc[]);
  }
  return out;
}
