import { colors, space, type Theme, typography } from "@legallabs/ui";

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// Set through the style object, which a strict content policy allows, unlike inline styles.
export function applyTheme(root: HTMLElement = document.documentElement) {
  const set = (name: string, value: string) => root.style.setProperty(`--${name}`, value);
  for (const [i, size] of space.entries()) set(`space-${i}`, `${size}px`);
  for (const [name, [size, line]] of Object.entries(typography)) {
    set(`text-${name}-size`, `${size}px`);
    set(`text-${name}-line`, `${line}px`);
  }
  const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const paint = () => {
    const theme: Theme = dark?.matches ? "dark" : "light";
    for (const [role, value] of Object.entries(colors[theme])) set(kebab(role), value);
    root.style.colorScheme = theme;
  };
  paint();
  dark?.addEventListener("change", paint);
}
