// A prompt names another column with `@{column_id}`. The editor shows `@{Label}` and the
// stored prompt keeps the id, so renaming a column never breaks a reference.

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const STORED = new RegExp(`@\\{(${UUID})\\}`, "g");
const DISPLAYED = /@\{([^{}\n]{1,80})\}/g;
const IS_ID = new RegExp(`^${UUID}$`);

/** Columns a stored prompt refers to, each once, in order of first mention. */
export function columnReferences(prompt: string): string[] {
  const seen = new Set<string>();
  for (const match of prompt.matchAll(STORED)) seen.add((match[1] ?? "").toLowerCase());
  return [...seen];
}

/** The stored prompt as the editor shows it: ids become labels; unknown ids stay as they are. */
export function promptForDisplay(
  prompt: string,
  labelOf: (columnId: string) => string | undefined,
): string {
  return prompt.replace(STORED, (whole, id: string) => {
    const label = labelOf(id.toLowerCase());
    return label ? `@{${label}}` : whole;
  });
}

export interface ParsedPrompt {
  prompt: string;
  /** Labels no column has. */
  unknown: string[];
  /** Labels more than one column has. */
  ambiguous: string[];
}

/** Turns the editor's `@{Label}` back into `@{id}`; a label is matched ignoring case. */
export function promptFromDisplay(
  text: string,
  columns: readonly { id: string; label: string }[],
): ParsedPrompt {
  const unknown = new Set<string>();
  const ambiguous = new Set<string>();
  const prompt = text.replace(DISPLAYED, (whole, name: string) => {
    if (IS_ID.test(name)) return `@{${name.toLowerCase()}}`;
    const wanted = name.trim().toLowerCase();
    const found = columns.filter((c) => c.label.trim().toLowerCase() === wanted);
    if (found.length === 0) unknown.add(name);
    else if (found.length > 1) ambiguous.add(name);
    else return `@{${found[0]?.id}}`;
    return whole;
  });
  return { prompt, unknown: [...unknown], ambiguous: [...ambiguous] };
}

/** The prompt with each reference replaced by the column's label, for the model to read. */
export function promptForModel(
  prompt: string,
  labelOf: (columnId: string) => string | undefined,
): string {
  return prompt.replace(STORED, (_, id: string) => `[${labelOf(id.toLowerCase()) ?? "a column"}]`);
}

/**
 * The cycle that `from`'s references close, in the order values flow (each column feeds the
 * next, the last feeds `from`'s first reference), or null when there is none.
 */
export function findCycle(
  edges: ReadonlyMap<string, readonly string[]>,
  from: string,
): string[] | null {
  const path: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (next === from) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      if (walk(next)) return true;
    }
    path.pop();
    return false;
  };
  return walk(from) ? path.reverse() : null;
}

/** Every column that depends on one of `ids`, directly or through others. */
export function dependentsOf(
  edges: ReadonlyMap<string, readonly string[]>,
  ids: Iterable<string>,
): string[] {
  const wanted = new Set(ids);
  const found = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [column, uses] of edges) {
      if (found.has(column)) continue;
      if (uses.some((u) => wanted.has(u) || found.has(u))) {
        found.add(column);
        grew = true;
      }
    }
  }
  return [...found];
}

/** Columns in an order where each comes after the ones it uses. */
export function inRunOrder<T extends { id: string; depends_on: readonly string[] }>(
  columns: readonly T[],
): T[] {
  const ordered: T[] = [];
  const done = new Set<string>();
  const ids = new Set(columns.map((c) => c.id));
  let rest = [...columns];
  while (rest.length > 0) {
    const ready = rest.filter((c) => c.depends_on.every((d) => done.has(d) || !ids.has(d)));
    // A cycle can't be saved; if one is here anyway, keep going in the given order.
    const next = ready.length > 0 ? ready : rest.slice(0, 1);
    for (const c of next) {
      ordered.push(c);
      done.add(c.id);
    }
    rest = rest.filter((c) => !next.includes(c));
  }
  return ordered;
}
