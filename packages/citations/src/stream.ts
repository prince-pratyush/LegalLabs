import { type CitedAnswer, type ParsedCitation, parseCitedAnswer } from "./parse.js";

export interface CitationStream {
  /** Adds model output; returns only text and citations that can no longer change. */
  push(delta: string): CitedAnswer;
  /** Ends the stream; returns whatever was still held back. */
  end(): CitedAnswer;
}

// Where an unfinished citation tag starts, if the output ends inside one. Only
// `<c` and `</c` can open one, so a plain "a < b" streams on at once.
function openTagAt(raw: string): number {
  const start = raw.lastIndexOf("<");
  if (start === -1) return -1;
  const rest = raw.slice(start + 1);
  // Still too short to tell: "<", "<c", "</", "</c".
  if (/^\/?c?$/.test(rest)) return start;
  if (rest.startsWith("/c")) return rest.startsWith("/c>") ? -1 : start;
  if (!/^c[\s/>]/.test(rest)) return -1;
  let quote: string | null = null;
  for (const char of rest.slice(1)) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return -1;
    }
  }
  return start;
}

/**
 * Parses cited output as it streams. Each push re-reads the whole output, which
 * is fine for answers capped at a few thousand tokens.
 * Only settled text is released, so a tag
 * is never shown half-written and offsets match the final parse.
 */
export function citationStream(): CitationStream {
  let raw = "";
  let textSent = 0;
  let citationsSent = 0;

  const release = (parsed: CitedAnswer): CitedAnswer => {
    const fresh = {
      text: parsed.text.slice(textSent),
      citations: parsed.citations.slice(citationsSent),
    };
    textSent = parsed.text.length;
    citationsSent = parsed.citations.length;
    return fresh;
  };

  return {
    push(delta) {
      raw += delta;
      const open = openTagAt(raw);
      const settled = open === -1 ? raw : raw.slice(0, open);
      return release(parseCitedAnswer(settled));
    },
    end: () => release(parseCitedAnswer(raw)),
  };
}

export type { ParsedCitation };
