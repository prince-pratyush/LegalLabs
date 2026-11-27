import {
  type IntakeFieldDef,
  type IntakeFieldType,
  type IntakeType,
  IntakeTypeCreate,
} from "@legallabs/contracts";

export interface FieldDraft {
  /** For React only. */
  row: number;
  /** Kept once saved: requests already made are stored under it. */
  key: string;
  label: string;
  type: IntakeFieldType;
  required: boolean;
  options: string;
  prompt: string;
}

export interface TypeDraft {
  name: string;
  description: string;
  sla: string;
  timeout: string;
  keywords: string;
  fields: FieldDraft[];
}

export const BLANK: TypeDraft = {
  name: "",
  description: "",
  sla: "8",
  timeout: "72",
  keywords: "",
  fields: [],
};

export const toDraft = (t: IntakeType): TypeDraft => ({
  name: t.name,
  description: t.description,
  sla: String(t.sla_hours),
  timeout: String(t.awaiting_requester_timeout_hours),
  keywords: t.keyword_rules.join("\n"),
  fields: t.fields.map((f, row) => ({
    row,
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    options: (f.options ?? []).join("\n"),
    prompt: f.prompt,
  })),
});

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50) || "field";

// Keys allow letters and underscores only, so a repeat takes another letter.
function freeKey(base: string, taken: Set<string>): string {
  let key = base;
  for (let n = 0; taken.has(key); n++) {
    key = `${base}_${String.fromCharCode(98 + (n % 25)).repeat(1 + Math.floor(n / 25))}`;
  }
  return key;
}

const HOURS = (text: string) => {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 720 ? n : null;
};

/** What to save, or the first thing still wrong with the form. */
export function toInput(draft: TypeDraft): IntakeTypeCreate | string {
  if (!draft.name.trim()) return "Give the type a name.";
  const sla = HOURS(draft.sla);
  const timeout = HOURS(draft.timeout);
  if (sla === null || timeout === null) return "Give hours as a whole number from 1 to 720.";
  const taken = new Set(draft.fields.map((f) => f.key).filter(Boolean));
  const fields: IntakeFieldDef[] = [];
  for (const f of draft.fields) {
    const label = f.label.trim();
    if (!label) return "Give every field a label.";
    const options = lines(f.options);
    if (f.type === "select" && !options.length) return `Give "${label}" at least one choice.`;
    const key = f.key || freeKey(slug(label), taken);
    taken.add(key);
    fields.push({
      key,
      label,
      type: f.type,
      required: f.required,
      prompt: f.prompt.trim(),
      ...(f.type === "select" ? { options } : {}),
    });
  }
  const input = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    sla_hours: sla,
    awaiting_requester_timeout_hours: timeout,
    keyword_rules: lines(draft.keywords),
    fields,
  };
  return IntakeTypeCreate.safeParse(input).success
    ? input
    : "Something is too long, or there are too many fields or keywords.";
}
