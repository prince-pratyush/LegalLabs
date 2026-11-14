import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const dir = new URL("./components/", import.meta.url);
const components = readdirSync(dir)
  .filter((name) => name.endsWith(".tsx") && !name.includes(".stories."))
  .map((name) => [name, readFileSync(new URL(name, dir), "utf8")] as const);

describe("focus ring", () => {
  it("is a 2 px accent outline on everything that takes focus", () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\)/);
  });

  it.each(components)("isn't switched off in %s", (_, source) => {
    expect(source).not.toMatch(/(?<![\w-])(focus(-visible)?:)?outline-none/);
    expect(source).not.toMatch(/focus(-visible)?:outline-0/);
  });
});

describe("reduced motion", () => {
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

  it("swaps every moving animation for a fade", () => {
    expect(block).toMatch(/--pop-in:\s*fade-in/);
    expect(block).toMatch(/--slide-in:\s*fade-in/);
    expect(block).toMatch(/--pulse-dot:\s*none/);
    expect(block).toMatch(/--shimmer:\s*none/);
  });

  it("limits transitions to opacity", () => {
    expect(block).toMatch(/transition-property:\s*opacity !important/);
  });

  it.each(components)("%s animates only through the motion variables", (_, source) => {
    expect(source).not.toMatch(/\banimate-(spin|bounce|ping|pulse)(?![\w-])/);
  });
});
