import { afterEach, expect, test, vi } from "vitest";
import { clearShellCache, registerWorker } from "./register.js";

afterEach(() => vi.unstubAllGlobals());

const stub = () => {
  const register = vi.fn(async () => ({}));
  const postMessage = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker: { register, controller: { postMessage } } });
  const names = new Set(["legallabs-shell-1", "other"]);
  vi.stubGlobal("caches", {
    keys: async () => [...names],
    delete: async (n: string) => names.delete(n),
  });
  return { register, postMessage, names };
};

test("registers the worker only in a production build", () => {
  const { register } = stub();
  registerWorker(false);
  window.dispatchEvent(new Event("load"));
  expect(register).not.toHaveBeenCalled();
  registerWorker(true);
  window.dispatchEvent(new Event("load"));
  expect(register).toHaveBeenCalledWith("/sw.js");
});

test("sign-out empties the app's caches, then asks for the offline page back", async () => {
  const { names, postMessage } = stub();
  await clearShellCache();
  expect([...names]).toEqual(["other"]);
  expect(postMessage).toHaveBeenCalledWith({ type: "refill" });
});

test("clearing never throws, with or without browser support", async () => {
  vi.stubGlobal("caches", {
    keys: async () => {
      throw new Error("blocked");
    },
  });
  await expect(clearShellCache()).resolves.toBeUndefined();
  vi.stubGlobal("caches", undefined);
  await expect(clearShellCache()).resolves.toBeUndefined();
});
