// Characters XML 1.0 forbids; Word refuses a file that holds any of them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being removed.
const INVALID = /[^\u{9}\u{A}\u{D}\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

export const clean = (text: string) => text.replace(INVALID, "");

export const xmlText = (text: string) =>
  clean(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Word's revision dates have no fractional seconds. */
export const isoSeconds = (date: Date | string) => `${new Date(date).toISOString().slice(0, 19)}Z`;

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
