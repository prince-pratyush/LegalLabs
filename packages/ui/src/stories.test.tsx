// @vitest-environment jsdom
import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import preview from "../.storybook/preview.js";
import { paintTheme } from "./theme.js";

setProjectAnnotations(preview);
afterEach(cleanup);

const modules = import.meta.glob<Record<string, unknown>>("./components/**/*.stories.tsx", {
  eager: true,
});

// jsdom can't compute colours, so contrast is checked on the tokens instead.
const OPTIONS: axe.RunOptions = {
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
};

describe("every component has stories", () => {
  const components = Object.keys(import.meta.glob("./components/**/*.tsx")).filter(
    (path) => !path.includes(".stories.") && !path.includes(".test."),
  );
  it.each(components)("%s", (path) => {
    expect(Object.keys(modules)).toContain(path.replace(".tsx", ".stories.tsx"));
  });
});

for (const [path, module] of Object.entries(modules)) {
  const stories = composeStories(module as Parameters<typeof composeStories>[0]) as Record<
    string,
    ComponentType
  >;
  describe(path, () => {
    for (const [name, Story] of Object.entries(stories)) {
      for (const theme of ["light", "dark"] as const) {
        it(`${name} in ${theme} has no axe violations`, async () => {
          paintTheme(document.documentElement, theme);
          render(<Story />);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const { violations } = await axe.run(document.body, OPTIONS);
          expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
        });
      }
    }
  });
}
