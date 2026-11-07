export type Theme = "light" | "dark";

// Components use roles, never raw hex, so a role can be retuned in one place.
export const colors = {
  light: {
    bg: "#FFFFFF",
    bgSubtle: "#F7F8FA",
    bgRaised: "#FFFFFF",
    fg: "#111418",
    fgMuted: "#5B6472",
    border: "#E3E6EB",
    accent: "#2D6BE4",
    citation: "#7C3AED",
    verified: "#15803D",
    flagged: "#C2410C",
    locked: "#6B7280",
    externalFg: "#B45309",
    externalBg: "#FEF3C7",
    destructive: "#B91C1C",
    warning: "#A16207",
  },
  dark: {
    bg: "#0E1116",
    bgSubtle: "#151921",
    bgRaised: "#1B2029",
    fg: "#E6E9EF",
    fgMuted: "#9AA3B2",
    border: "#2A3140",
    accent: "#6B9CFF",
    citation: "#A78BFA",
    verified: "#4ADE80",
    flagged: "#FB923C",
    locked: "#9CA3AF",
    externalFg: "#FCD34D",
    externalBg: "#3B2F0B",
    destructive: "#F87171",
    warning: "#FACC15",
  },
} as const satisfies Record<Theme, Record<string, `#${string}`>>;

export type ColorRole = keyof (typeof colors)["light"];

export const space = [4, 8, 12, 16, 24, 32, 48] as const;

// [font size, line height] in px.
export const type = {
  caption: [12, 16],
  dense: [13, 18],
  body: [14, 20],
  prose: [16, 24],
  section: [18, 26],
  title: [22, 28],
  display: [28, 34],
} as const;

export const motion = { fast: 120, panel: 180, content: 240 } as const;
