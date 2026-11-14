import type { StorybookConfig } from "@storybook/react-vite";
import tailwind from "@tailwindcss/vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
  viteFinal: (vite) => ({ ...vite, plugins: [...(vite.plugins ?? []), tailwind()] }),
};

export default config;
