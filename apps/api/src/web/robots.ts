/** The product token a site's robots.txt can name. */
export const ROBOTS_TOKEN = "legallabs";

const MAX_RULES = 1000;
const MAX_PATTERN = 500;

interface Rule {
  allow: boolean;
  pattern: string;
}

/** `*` matches any run and a final `$` anchors the end. Each part is found once, left to right. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
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

/** Rules for our token, or for every agent when none names it (RFC 9309). */
function rulesFor(robots: string): Rule[] {
  const ours: Rule[] = [];
  const anyone: Rule[] = [];
  let named = false;
  let agents: string[] = [];
  let inRules = false;
  for (const line of robots.split(/\r\n?|\n/)) {
    const [, field = "", value = ""] =
      /^\s*([A-Za-z-]+)\s*:(.*)$/.exec(line.split("#")[0] ?? "") ?? [];
    const key = field.toLowerCase();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      const agent = value.trim().toLowerCase();
      agents.push(agent);
      if (agent === ROBOTS_TOKEN) named = true;
      continue;
    }
    if (key !== "allow" && key !== "disallow") continue;
    inRules = true;
    const pattern = value.trim().slice(0, MAX_PATTERN);
    if (!pattern) continue;
    const rule = { allow: key === "allow", pattern };
    if (agents.includes(ROBOTS_TOKEN) && ours.length < MAX_RULES) ours.push(rule);
    if (agents.includes("*") && anyone.length < MAX_RULES) anyone.push(rule);
  }
  return named ? ours : anyone;
}

/** Whether `path` (with its query) may be fetched. The longest matching rule decides. */
export function robotsAllow(robots: string, path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rulesFor(robots)) {
    if (!matches(rule.pattern, path)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    if (longer || (rule.pattern.length === best?.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}
