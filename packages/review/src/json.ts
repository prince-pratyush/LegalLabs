/**
 * The first JSON object in a model reply. Small local models wrap JSON in think tags,
 * code fences or prose despite being told not to, so all of that is skipped.
 */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
  let start = cleaned.indexOf("{");
  while (start !== -1) {
    const end = matchingBrace(cleaned, start);
    if (end === -1) return undefined;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      start = cleaned.indexOf("{", start + 1);
    }
  }
  return undefined;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
