const PREFIX = "legallabs-shell-";

/** Installs the service worker; the dev server has none, so only a build asks for it. */
export function registerWorker(enabled: boolean = import.meta.env.PROD): void {
  if (!enabled || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    // Without it the app still works, only not offline.
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

/** For sign-out: nothing the app stored stays behind, then the offline page is fetched afresh. */
export async function clearShellCache(): Promise<void> {
  try {
    if (!globalThis.caches) return;
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(PREFIX)).map((n) => caches.delete(n)));
    navigator.serviceWorker?.controller?.postMessage({ type: "refill" });
  } catch {
    // Storage can be blocked; signing out must still happen.
  }
}
