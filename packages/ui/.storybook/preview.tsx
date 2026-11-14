import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import { paintTheme } from "../src/theme.js";
import type { Theme } from "../src/tokens.js";
import "../src/styles.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Colour theme",
      toolbar: { title: "Theme", icon: "mirror", items: ["light", "dark"], dynamicTitle: true },
    },
    density: {
      description: "Row and text density",
      toolbar: {
        title: "Density",
        icon: "component",
        items: ["comfortable", "compact"],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light", density: "comfortable" },
  parameters: {
    layout: "padded",
    a11y: { test: "error" },
    backgrounds: { disable: true },
  },
  decorators: [
    (Story, { globals }) => {
      const theme = (globals.theme ?? "light") as Theme;
      const density = globals.density ?? "comfortable";
      // Painted before render too, so the first frame is already in the right theme.
      paintTheme(document.documentElement, theme);
      document.documentElement.dataset.density = density;
      useEffect(() => {
        document.body.style.background = "var(--bg)";
      }, []);
      return <Story />;
    },
  ],
};

export default preview;
