import { type CitedAnswer, type ParsedCitation, parseCitedAnswer } from "./parse.js";

export interface CitationStream {
  /** Adds model output; returns only text and citations that can no longer change. */
  push(delta: string): CitedAnswer;
  /** Ends the stream; returns whatever was still held back. */
  end(): CitedAnswer;
}

// Where an unfinished tag starts, if the output ends inside one. Quotes are
// respected, so a `>` inside a quote value doesn't count as the end.
function openTagAt(raw: string): number {
  const start = raw.lastIndexOf("<");
  if (start === -1) return -1;
  let quote: string | null = null;
  for (let i = start + 1; i < raw.length; i++) {
    const char = raw[i];
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
 * Parses cited output as it streams. Only settled text is released, so a tag
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
