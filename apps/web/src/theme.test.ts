import { colors } from "@legallabs/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme } from "./theme.js";

afterEach(() => vi.unstubAllGlobals());

const prefersDark = (dark: boolean) =>
  vi.stubGlobal("matchMedia", () => ({ matches: dark, addEventListener: () => {} }));

describe("applyTheme", () => {
  it("turns the shared tokens into CSS variables", () => {
    prefersDark(false);
    const root = document.createElement("div");
    applyTheme(root);
    expect(root.style.getPropertyValue("--bg")).toBe(colors.light.bg);
    expect(root.style.getPropertyValue("--bg-subtle")).toBe(colors.light.bgSubtle);
    expect(root.style.getPropertyValue("--space-3")).toBe("16px");
    expect(root.style.getPropertyValue("--text-body-size")).toBe("14px");
  });

  it("follows a dark system setting", () => {
    prefersDark(true);
    const root = document.createElement("div");
    applyTheme(root);
    expect(root.style.getPropertyValue("--flagged")).toBe(colors.dark.flagged);
  });
});
