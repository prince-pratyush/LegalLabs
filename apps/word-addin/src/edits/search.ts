/**
 * Text as Word's search reads it: `^` starts a special code, so it is doubled,
 * and tabs and line breaks have codes of their own.
 */
export const searchText = (text: string) =>
  text.replace(/\^/g, "^^").replace(/\t/g, "^t").replace(/\v/g, "^l");
