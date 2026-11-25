/**
 * Checks a tool call's arguments against the pinned input schema (CON-001: "arguments
 * (schema-validated)"). It covers type, required, properties, additionalProperties, items and
 * enum, and deliberately not `pattern`: the schema comes from the server, and running its
 * regular expressions would let it stall this process. Returns why not, or null.
 */

export const MAX_ARGUMENT_CHARS = 8_000;
const MAX_DEPTH = 12;

type Schema = Record<string, unknown>;

const typeOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

const isObject = (v: unknown): v is Schema =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function check(value: unknown, schema: unknown, at: string, depth: number): string | null {
  if (!isObject(schema)) return null;
  if (depth > MAX_DEPTH) return `${at} is nested too deeply`;
  const wanted = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = typeOf(value);
  if (
    wanted.length > 0 &&
    !wanted.includes(actual) &&
    !(actual === "integer" && wanted.includes("number"))
  ) {
    return `${at} should be ${wanted.join(" or ")}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    return `${at} is not one of the allowed values`;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const bad = check(item, schema.items, `${at}[${i}]`, depth + 1);
      if (bad) return bad;
    }
  } else if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, String(key))) return `${at}.${key} is required`;
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const bad = check(item, properties[key], `${at}.${key}`, depth + 1);
        if (bad) return bad;
      } else if (schema.additionalProperties === false) {
        return `${at}.${key} is not an argument of this tool`;
      }
    }
  }
  return null;
}

export function argumentProblem(args: unknown, schema: Schema): string | null {
  if (!isObject(args)) return "arguments should be an object";
  if (JSON.stringify(args).length > MAX_ARGUMENT_CHARS) return "arguments are too long";
  return check(args, schema, "arguments", 0);
}
