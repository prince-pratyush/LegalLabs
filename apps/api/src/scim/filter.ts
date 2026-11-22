import { badRequest } from "./errors.js";
import { knownUrn } from "./schemas.js";

// RFC 7644 section 3.4.2.2: attribute expressions, and/or/not, parentheses and value paths.

export interface AttrPath {
  /** The extension schema the attribute belongs to, in its canonical spelling. */
  urn?: string;
  parts: string[];
}

export type Literal = string | number | boolean | null;
export type CompareOp = "eq" | "ne" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le";

export type Filter =
  | { type: "and" | "or"; left: Filter; right: Filter }
  | { type: "not"; filter: Filter }
  | { type: "present"; path: AttrPath }
  | { type: "compare"; op: CompareOp; path: AttrPath; value: Literal }
  | { type: "valuePath"; path: AttrPath; filter: Filter };

const COMPARE = new Set<string>(["eq", "ne", "co", "sw", "ew", "gt", "ge", "lt", "le"]);
const MAX_LENGTH = 4000;
const MAX_DEPTH = 40;

type Token =
  | { kind: "punct"; text: "(" | ")" | "[" | "]" }
  | { kind: "string"; text: string }
  | { kind: "word"; text: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "(" || ch === ")" || ch === "[" || ch === "]") {
      tokens.push({ kind: "punct", text: ch });
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') j += input[j] === "\\" ? 2 : 1;
      if (j >= input.length) throw badRequest("invalidFilter", "Unterminated string in filter.");
      try {
        tokens.push({ kind: "string", text: JSON.parse(input.slice(i, j + 1)) as string });
      } catch {
        throw badRequest("invalidFilter", "Bad escape in a filter string.");
      }
      i = j + 1;
    } else {
      let j = i;
      while (j < input.length && !/[\s()[\]"]/.test(input[j] ?? "")) j++;
      tokens.push({ kind: "word", text: input.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

/** Splits `urn:...:attr.sub` at the last colon; names that are not ours are refused. */
export function parseAttrPath(text: string): AttrPath {
  let urn: string | undefined;
  let rest = text;
  const colon = text.lastIndexOf(":");
  if (colon >= 0) {
    const known = knownUrn(text.slice(0, colon));
    if (!known) throw badRequest("invalidPath", `Unknown schema in attribute path: ${text}`);
    urn = known;
    rest = text.slice(colon + 1);
  }
  const parts = rest.split(".");
  if (parts.length > 2 || parts.some((p) => !/^[A-Za-z$][A-Za-z0-9_$-]*$/.test(p))) {
    throw badRequest("invalidPath", `Bad attribute path: ${text}`);
  }
  return { ...(urn ? { urn } : {}), parts };
}

export function parseFilter(input: string): Filter {
  if (input.length > MAX_LENGTH) throw badRequest("invalidFilter", "Filter is too long.");
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (t: Token | undefined, word: string) =>
    t?.kind === "word" && t.text.toLowerCase() === word;
  const fail = (why: string): never => {
    throw badRequest("invalidFilter", why);
  };

  function parseOr(depth: number): Filter {
    if (depth > MAX_DEPTH) return fail("Filter is nested too deeply.");
    let left = parseAnd(depth);
    while (isWord(peek(), "or")) {
      pos++;
      left = { type: "or", left, right: parseAnd(depth) };
    }
    return left;
  }

  function parseAnd(depth: number): Filter {
    let left = parseUnary(depth);
    while (isWord(peek(), "and")) {
      pos++;
      left = { type: "and", left, right: parseUnary(depth) };
    }
    return left;
  }

  function expectPunct(text: string) {
    const t = peek();
    if (t?.kind !== "punct" || t.text !== text) fail(`Expected "${text}" in filter.`);
    pos++;
  }

  function parseUnary(depth: number): Filter {
    const t = peek();
    if (isWord(t, "not")) {
      pos++;
      expectPunct("(");
      const inner = parseOr(depth + 1);
      expectPunct(")");
      return { type: "not", filter: inner };
    }
    if (t?.kind === "punct" && t.text === "(") {
      pos++;
      const inner = parseOr(depth + 1);
      expectPunct(")");
      return inner;
    }
    return parseAttribute(depth);
  }

  function parseAttribute(depth: number): Filter {
    const t = peek();
    if (t?.kind !== "word") return fail("Expected an attribute name in filter.");
    pos++;
    const path = parseAttrPath(t.text);
    const next = peek();
    if (next?.kind === "punct" && next.text === "[") {
      pos++;
      const inner = parseOr(depth + 1);
      expectPunct("]");
      return { type: "valuePath", path, filter: inner };
    }
    const opToken = peek();
    if (opToken?.kind !== "word") return fail(`Expected an operator after ${t.text}.`);
    pos++;
    const op = opToken.text.toLowerCase();
    if (op === "pr") return { type: "present", path };
    if (!COMPARE.has(op)) return fail(`Unknown operator "${opToken.text}".`);
    const v = peek();
    if (!v) return fail(`Missing value after ${op}.`);
    pos++;
    return { type: "compare", op: op as CompareOp, path, value: literal(v) };
  }

  function literal(t: Token): Literal {
    if (t.kind === "string") return t.text;
    if (t.kind === "punct") return fail("Expected a value in filter.");
    const lower = t.text.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (lower === "null") return null;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t.text)) return Number(t.text);
    return fail(`Unquoted value "${t.text}" in filter.`);
  }

  if (tokens.length === 0) fail("Empty filter.");
  const result = parseOr(0);
  if (pos < tokens.length) fail("Unexpected text at the end of the filter.");
  return result;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function keyed(obj: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(obj).find((k) => same(k, name));
  return key === undefined ? undefined : obj[key];
}

/** Every value the path reaches, flattening multi-valued attributes. */
export function valuesAt(node: unknown, parts: string[]): unknown[] {
  if (Array.isArray(node)) return node.flatMap((n) => valuesAt(n, parts));
  if (parts.length === 0) return node === undefined || node === null ? [] : [node];
  if (typeof node !== "object" || node === null) return [];
  const [head, ...rest] = parts;
  return valuesAt(keyed(node as Record<string, unknown>, head ?? ""), rest);
}

export function resolvePath(doc: Record<string, unknown>, path: AttrPath): unknown[] {
  const base = path.urn ? keyed(doc, path.urn) : doc;
  return valuesAt(base, path.parts);
}

const CASE_EXACT = new Set(["id", "externalid"]);
const DATE_TIME = new Set(["meta.created", "meta.lastmodified"]);

function present(v: unknown) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function compareOne(v: unknown, op: CompareOp, lit: Literal, path: AttrPath): boolean {
  const name = path.urn ? "" : path.parts.join(".").toLowerCase();
  if (DATE_TIME.has(name)) {
    const a = typeof v === "string" ? Date.parse(v) : Number.NaN;
    const b = typeof lit === "string" ? Date.parse(lit) : Number.NaN;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return order(a, b, op);
  }
  if (typeof v === "boolean") {
    const want = typeof lit === "string" ? lit.toLowerCase() === "true" : lit;
    // Entra sends "True"/"False" as text, so a quoted boolean still compares.
    if (typeof lit === "string" && !["true", "false"].includes(lit.toLowerCase())) return false;
    return op === "eq" ? v === want : op === "ne" ? v !== want : false;
  }
  if (typeof v === "number") {
    return typeof lit === "number" ? order(v, lit, op) : false;
  }
  if (typeof v === "string" && typeof lit === "string") {
    const exact = CASE_EXACT.has(name);
    const a = exact ? v : v.toLowerCase();
    const b = exact ? lit : lit.toLowerCase();
    switch (op) {
      case "co":
        return a.includes(b);
      case "sw":
        return a.startsWith(b);
      case "ew":
        return a.endsWith(b);
      default:
        return order(a, b, op);
    }
  }
  return false;
}

function order<T extends string | number>(a: T, b: T, op: CompareOp): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
    case "lt":
      return a < b;
    case "le":
      return a <= b;
    default:
      return false;
  }
}

/** Whether a resource (or, inside a value path, one element) satisfies the filter. */
export function matches(filter: Filter, doc: Record<string, unknown>): boolean {
  switch (filter.type) {
    case "and":
      return matches(filter.left, doc) && matches(filter.right, doc);
    case "or":
      return matches(filter.left, doc) || matches(filter.right, doc);
    case "not":
      return !matches(filter.filter, doc);
    case "present":
      return resolvePath(doc, filter.path).some(present);
    case "valuePath":
      return resolvePath(doc, filter.path).some(
        (el) => typeof el === "object" && el !== null && matches(filter.filter, el as never),
      );
    case "compare": {
      const values = resolvePath(doc, filter.path);
      if (filter.value === null) {
        const none = values.length === 0;
        return filter.op === "eq" ? none : filter.op === "ne" ? !none : false;
      }
      // "ne" means no value equals it, which is also true when the attribute is unset.
      if (filter.op === "ne") {
        return !values.some((v) => compareOne(v, "eq", filter.value, filter.path));
      }
      return values.some((v) => compareOne(v, filter.op, filter.value, filter.path));
    }
  }
}

/** A single top-level equality, which the database can answer without loading everyone. */
export function simpleEquality(
  filter: Filter,
): { attr: "id" | "userName" | "externalId"; value: string } | null {
  if (filter.type !== "compare" || filter.op !== "eq" || typeof filter.value !== "string") {
    return null;
  }
  if (filter.path.urn || filter.path.parts.length !== 1) return null;
  const name = (filter.path.parts[0] ?? "").toLowerCase();
  if (name === "id") return { attr: "id", value: filter.value };
  if (name === "username") return { attr: "userName", value: filter.value };
  if (name === "externalid") return { attr: "externalId", value: filter.value };
  return null;
}

/** The equality terms of a conjunction, such as `type eq "work"`, for building a new element. */
export function equalityTerms(filter: Filter): Record<string, Literal> | null {
  if (filter.type === "compare" && filter.op === "eq" && filter.path.parts.length === 1) {
    return { [filter.path.parts[0] ?? ""]: filter.value };
  }
  if (filter.type === "and") {
    const left = equalityTerms(filter.left);
    const right = equalityTerms(filter.right);
    return left && right ? { ...left, ...right } : null;
  }
  return null;
}
