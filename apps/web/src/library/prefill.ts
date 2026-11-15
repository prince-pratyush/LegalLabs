// The composer lives in another page; this hands it text across one navigation.
const KEY = "legallabs.composer.prefill";

/** Opens a new thread with `text` in the composer, unsent. */
export function sendToComposer(text: string) {
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    // Storage can be off; the user can still paste the prompt.
  }
  window.location.hash = "#/";
}

/** The text waiting for the composer, read once. */
export function takeComposerPrefill(): string | null {
  try {
    const text = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return text;
  } catch {
    return null;
  }
}
