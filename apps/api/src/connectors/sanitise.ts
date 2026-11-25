/**
 * Tool output before it reaches a prompt (CON-001, 06-security 7.1): capped, stripped of control
 * and invisible characters, and with instruction-like lines marked as quoted data. This lowers
 * the odds a model obeys planted text; it is advisory. The policy engine is the control.
 */

export const TOOL_OUTPUT_CAP = 32_000;
const MARK = "[untrusted content]";

// C0/C1 controls (not tab or newline), zero-width and bidi overrides, and Unicode tag characters.
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

const HTML = /<\/?(?:html|head|body|div|span|p|a|br|script|style|iframe|table|ul|li|h[1-6])\b/i;

const INSTRUCTION = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|your|these|the)\b.{0,20}\b(?:instructions?|prompts?|rules)\b/i,
  /^\s*(?:system|assistant|developer|user)\s*:/i,
  /<\/?(?:system|assistant|instructions?|tool_call)\b[^>]*>/i,
  /\[\/?(?:INST|SYSTEM)\]|<\|[a-z_]+\|>/i,
  /^\s*(?:TOOL|ASK)\s*:/,
  /\b(?:you (?:must|should|are now|need to|will now)|(?:dear )?(?:assistant|ai|agent|model)\s*[,:])/i,
  /\b(?:now|please|immediately)\s+(?:send|delete|email|forward|share|upload|call|run|execute|file)\b/i,
];

export interface Sanitised {
  text: string;
  /** Lines marked as instruction-like. */
  flagged: number;
  truncated: boolean;
}

export function sanitiseToolOutput(raw: string, cap: number = TOOL_OUTPUT_CAP): Sanitised {
  const truncated = raw.length > cap;
  let text = raw.slice(0, cap).replace(INVISIBLE, "");
  if (HTML.test(text)) {
    text = text
      .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?[a-zA-Z][^<>]*>/g, " ");
  }
  let flagged = 0;
  text = text
    .split("\n")
    .map((line) => {
      if (!INSTRUCTION.some((pattern) => pattern.test(line))) return line;
      flagged += 1;
      return `${MARK} "${line}"`;
    })
    .join("\n");
  if (truncated) text += "\n[truncated]";
  return { text, flagged, truncated };
}
