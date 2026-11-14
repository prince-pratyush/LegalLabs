import { colors, motion, space, type Theme, typography } from "./tokens.js";

export type ThemeSetting = Theme | "system";
export type Density = "comfortable" | "compact";

const THEME_KEY = "legallabs.theme";
const DENSITY_KEY = "legallabs.density";

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// Storage can throw in private windows; a missing setting just means the default.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function themeSetting(): ThemeSetting {
  const value = read(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function densitySetting(): Density {
  return read(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

const systemDark = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function resolveTheme(setting: ThemeSetting): Theme {
  if (setting !== "system") return setting;
  return systemDark()?.matches ? "dark" : "light";
}

// Set through the style object, which a strict content policy allows, unlike inline styles.
export function paintTheme(root: HTMLElement, theme: Theme) {
  const set = (name: string, value: string) => root.style.setProperty(`--${name}`, value);
  for (const [i, size] of space.entries()) set(`space-${i}`, `${size}px`);
  for (const [name, [size, line]] of Object.entries(typography)) {
    set(`text-${name}-size`, `${size}px`);
    set(`text-${name}-line`, `${line}px`);
  }
  for (const [name, ms] of Object.entries(motion)) set(`motion-${name}`, `${ms}ms`);
  for (const [role, value] of Object.entries(colors[theme])) set(kebab(role), value);
  root.style.colorScheme = theme;
  root.dataset.theme = theme;
}

/** Paints the saved or system theme, and follows the system while set to "system". */
export function applyTheme(root: HTMLElement = document.documentElement): () => void {
  const paint = () => paintTheme(root, resolveTheme(themeSetting()));
  paint();
  root.dataset.density = densitySetting();
  const dark = systemDark();
  dark?.addEventListener("change", paint);
  return () => dark?.removeEventListener("change", paint);
}

export function setThemeSetting(setting: ThemeSetting, root = document.documentElement) {
  write(THEME_KEY, setting);
  paintTheme(root, resolveTheme(setting));
}

export function setDensity(density: Density, root = document.documentElement) {
  write(DENSITY_KEY, density);
  root.dataset.density = density;
}
