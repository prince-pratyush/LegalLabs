// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, setDensity, setThemeSetting, themeSetting } from "./theme.js";
import { colors } from "./tokens.js";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const prefersDark = (dark: boolean) =>
  vi.stubGlobal("matchMedia", () => ({
    matches: dark,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe("applyTheme", () => {
  it("turns the shared tokens into CSS variables", () => {
    prefersDark(false);
    const root = document.createElement("div");
    applyTheme(root);
    expect(root.style.getPropertyValue("--bg")).toBe(colors.light.bg);
    expect(root.style.getPropertyValue("--bg-subtle")).toBe(colors.light.bgSubtle);
    expect(root.style.getPropertyValue("--space-3")).toBe("16px");
    expect(root.style.getPropertyValue("--text-body-size")).toBe("14px");
    expect(root.style.getPropertyValue("--motion-panel")).toBe("180ms");
    expect(root.dataset.density).toBe("comfortable");
  });

  it("follows a dark system setting", () => {
    prefersDark(true);
    const root = document.createElement("div");
    applyTheme(root);
    expect(root.style.getPropertyValue("--flagged")).toBe(colors.dark.flagged);
    expect(root.dataset.theme).toBe("dark");
  });

  it("lets the person's choice win over the system", () => {
    prefersDark(true);
    const root = document.createElement("div");
    setThemeSetting("light", root);
    applyTheme(root);
    expect(themeSetting()).toBe("light");
    expect(root.style.getPropertyValue("--bg")).toBe(colors.light.bg);
  });

  it("remembers compact density", () => {
    prefersDark(false);
    const root = document.createElement("div");
    setDensity("compact", root);
    applyTheme(root);
    expect(root.dataset.density).toBe("compact");
  });
});
