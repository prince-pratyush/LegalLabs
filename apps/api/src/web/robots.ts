/** The product token a site's robots.txt can name. */
export const ROBOTS_TOKEN = "legallabs";

const MAX_RULES = 1000;
const MAX_PATTERN = 500;
// Wildcard-separated pieces across a group, each of which can cost a pass over the path.
const MAX_PARTS = 2000;

interface Rule {
  allow: boolean;
  length: number;
  parts: string[];
  anchored: boolean;
}

/** The rules that apply to us, or null for a file too big to weigh, which closes the site. */
export type Robots = readonly Rule[] | null;

/** `*` matches any run and a final `$` anchors the end. Each part is found once, left to right. */
function matches({ parts, anchored }: Rule, path: string): boolean {
  const first = parts[0] ?? "";
  if (!path.startsWith(first)) return false;
  let at = first.length;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (anchored && i === parts.length - 1) {
      return path.length - part.length >= at && path.endsWith(part);
    }
    const found = path.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return !anchored || at === path.length;
}

/**
 * Rules for our token, or for every agent when none names it (RFC 9309). One pass: a group's
 * agents are kept as two flags, so a long list of them costs nothing at each rule.
 */
export function parseRobots(robots: string): Robots {
  const group = () => ({ rules: [] as Rule[], parts: 0, over: false });
  const ours = group();
  const anyone = group();
  let named = false;
  let forUs = false;
  let forAll = false;
  let inRules = false;
  const add = (to: ReturnType<typeof group>, rule: Rule) => {
    to.parts += rule.parts.length;
    if (to.rules.length >= MAX_RULES || to.parts > MAX_PARTS) to.over = true;
    else to.rules.push(rule);
  };
  for (const line of robots.split(/\r\n?|\n/)) {
    const [, field = "", value = ""] =
      /^\s*([A-Za-z-]+)\s*:(.*)$/.exec(line.split("#")[0] ?? "") ?? [];
    const key = field.toLowerCase();
    if (key === "user-agent") {
      if (inRules) {
        forUs = false;
        forAll = false;
      }
      inRules = false;
      const agent = value.trim().toLowerCase();
      if (agent === ROBOTS_TOKEN) {
        forUs = true;
        named = true;
      }
      if (agent === "*") forAll = true;
      continue;
    }
    if (key !== "allow" && key !== "disallow") continue;
    inRules = true;
    if (!forUs && !forAll) continue;
    const pattern = value
      .trim()
      .slice(0, MAX_PATTERN)
      .replace(/\*{2,}/g, "*");
    if (!pattern) continue;
    const anchored = pattern.endsWith("$");
    const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
    const rule = { allow: key === "allow", length: pattern.length, parts, anchored };
    if (forUs) add(ours, rule);
    if (forAll) add(anyone, rule);
  }
  const applies = named ? ours : anyone;
  return applies.over ? null : applies.rules;
}

/** Whether `path` (with its query) may be fetched. The longest matching rule decides. */
export function robotsAllow(robots: Robots, path: string): boolean {
  if (robots === null) return false;
  let best: Rule | null = null;
  for (const rule of robots) {
    if (!matches(rule, path)) continue;
    const longer = !best || rule.length > best.length;
    if (longer || (rule.length === best?.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}
