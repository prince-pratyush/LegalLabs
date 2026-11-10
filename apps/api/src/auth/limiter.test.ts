import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter.js";

describe("a limiter", () => {
  it("allows up to the limit, then says how long to wait", () => {
    let time = 0;
    const limiter = createLimiter({ limit: 2, windowMs: 60_000, now: () => time });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    time = 15_000;
    expect(limiter.take("a")).toBe(45);
  });

  it("counts each key apart", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("b")).toBe(0);
  });

  it("starts again after the window", () => {
    let time = 0;
    const limiter = createLimiter({ limit: 1, windowMs: 60_000, now: () => time });
    limiter.take("a");
    time = 60_000;
    expect(limiter.take("a")).toBe(0);
  });

  it("refuses new keys while full, so memory stays bounded", () => {
    let time = 0;
    const limiter = createLimiter({ limit: 1, windowMs: 1_000, now: () => time, maxKeys: 2 });
    limiter.take("a");
    limiter.take("b");
    expect(limiter.take("c")).toBe(1);
    time = 2_000;
    expect(limiter.take("c")).toBe(0);
  });
});
