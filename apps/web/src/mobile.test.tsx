import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CommandCenterApp } from "./command-center/CommandCenterApp.js";
import { LibraryApp } from "./library/LibraryApp.js";
import { DesktopOnly } from "./mobile.js";
import { serve } from "./testing.js";

const phone = () =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

afterEach(() => vi.unstubAllGlobals());

test("a builder says to use a larger screen on a phone, and shows otherwise", () => {
  const builder = (
    <DesktopOnly>
      <p>Builder</p>
    </DesktopOnly>
  );
  const view = render(builder);
  expect(screen.getByText("Builder")).toBeTruthy();
  view.unmount();
  phone();
  render(builder);
  expect(screen.queryByText("Builder")).toBeNull();
  expect(screen.getByText("Open this on a larger screen")).toBeTruthy();
});

test("the Command Center is not on phones", () => {
  phone();
  serve({});
  render(<CommandCenterApp onLeave={() => {}} />);
  expect(screen.getByText("Open this on a larger screen")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Analytics" })).toBeNull();
});

test("the Library is read-only on a phone", async () => {
  phone();
  serve({
    "GET /api/v1/library/abilities": () => [200, { manage: true, draft: true }],
    "GET /api/v1/library/prompts": () => [
      200,
      {
        prompts: [
          {
            id: "p1",
            name: "Cap check",
            description: "",
            text: "Cap?",
            variables: [],
            owner: { name: "Ana" },
            shared: false,
            access: "owner",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ],
    "GET /api/v1/library/templates": () => [200, { templates: [] }],
  });
  render(<LibraryApp onLeave={() => {}} />);
  expect(await screen.findByRole("button", { name: /^Use/ })).toBeTruthy();
  for (const name of [/New prompt/, /Upload template/, /Edit/, /Share/, /Delete/]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
});
