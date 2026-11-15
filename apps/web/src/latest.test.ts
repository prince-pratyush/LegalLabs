import { describe, expect, it } from "vitest";
import { latestOnly } from "./latest.js";

describe("latestOnly", () => {
  it("marks an older response stale when a newer one was asked for", async () => {
    const pending: ((value: string) => void)[] = [];
    const load = latestOnly(() => new Promise<string>((resolve) => pending.push(resolve)));
    const first = load();
    const second = load();
    pending[1]?.("new");
    pending[0]?.("old");
    expect(await second).toEqual({ current: true, value: "new" });
    expect(await first).toEqual({ current: false });
  });

  it("passes a lone response through", async () => {
    const load = latestOnly(async (n: number) => n * 2);
    expect(await load(2)).toEqual({ current: true, value: 4 });
  });
});
