import { applyTheme, paintTheme, type Theme } from "@legallabs/ui";

/** Dark when Office's own background is dark, so the pane matches the window around it. */
export function themeOf(background: string | undefined): Theme | null {
  const hex = /^#?([0-9a-f]{6})$/i.exec(background?.trim() ?? "")?.[1];
  if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  // Relative luminance, close enough to tell light from dark.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "dark" : "light";
}

/** Follows Office's theme where the host reports one, and the system's otherwise. */
export function followOfficeTheme(root: HTMLElement = document.documentElement) {
  applyTheme(root);
  const paint = () => {
    try {
      const theme = themeOf(Office.context.officeTheme?.bodyBackgroundColor);
      if (theme) paintTheme(root, theme);
    } catch {
      // Hosts without officeTheme keep the system theme applyTheme set.
    }
  };
  paint();
  try {
    Office.context.document.addHandlerAsync(
      // Not in every host's typings or builds: an unknown event type just fails quietly.
      "officeThemeChanged" as unknown as Office.EventType,
      paint,
    );
  } catch {
    // No theme events in this host: the pane keeps the theme it opened with.
  }
}
