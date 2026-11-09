export interface Located {
  from: number;
  to: number;
  text: string;
  exact: boolean;
}

export type QuoteResult = { found: true; located: Located } | { found: false };

interface Normalized {
  text: string;
  // Original offsets of each normalised character, so a match maps back to the real page.
  starts: number[];
  ends: number[];
}

function normalize(raw: string): Normalized {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charAt(i);
    if (/\s/.test(char)) {
      if (text.length === 0) continue;
      if (text.endsWith(" ")) {
        ends[ends.length - 1] = i + 1;
        continue;
      }
      text += " ";
    } else {
      text += char;
    }
    starts.push(i);
    ends.push(i + 1);
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

export function locateQuote(page: string, quote: string): QuoteResult {
  const haystack = normalize(page);
  const needle = normalize(quote).text;
  const at = haystack.text.indexOf(needle);
  if (at < 0) return { found: false };
  const from = haystack.starts[at] as number;
  const to = haystack.ends[at + needle.length - 1] as number;
  return { found: true, located: { from, to, text: page.slice(from, to), exact: true } };
}
