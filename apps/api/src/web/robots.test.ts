import { describe, expect, it } from "vitest";
import { robotsAllow } from "./robots.js";

describe("robotsAllow", () => {
  it("allows everything when nothing applies", () => {
    expect(robotsAllow("", "/a")).toBe(true);
    expect(robotsAllow("User-agent: other\nDisallow: /", "/a")).toBe(true);
    expect(robotsAllow("User-agent: *\nDisallow:", "/a")).toBe(true);
  });

  it("follows the group for every agent", () => {
    const robots = "# note\nUser-agent: *\nDisallow: /private\n";
    expect(robotsAllow(robots, "/private/x")).toBe(false);
    expect(robotsAllow(robots, "/public")).toBe(true);
  });

  it("prefers a group naming this fetcher", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: LegalLabs\nDisallow: /x\n";
    expect(robotsAllow(robots, "/a")).toBe(true);
    expect(robotsAllow(robots, "/x")).toBe(false);
  });

  it("takes the longest match, and allow on a tie", () => {
    const robots = "User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /c\nAllow: /c";
    expect(robotsAllow(robots, "/a/z")).toBe(false);
    expect(robotsAllow(robots, "/a/b/c")).toBe(true);
    expect(robotsAllow(robots, "/c")).toBe(true);
  });

  it("reads * and $ without backtracking", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /q*private";
    expect(robotsAllow(robots, "/f/a.pdf")).toBe(false);
    expect(robotsAllow(robots, "/f/a.pdf.html")).toBe(true);
    expect(robotsAllow(robots, "/q?x=private")).toBe(false);
    const hostile = `User-agent: *\nDisallow: /${"*a".repeat(200)}b`;
    const started = Date.now();
    expect(robotsAllow(hostile, `/${"a".repeat(2000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
