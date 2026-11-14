import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AppShell } from "./app-shell.js";
import { SAMPLE_COMMANDS } from "./command-palette.stories.js";
import { CitationMarker } from "./evidence.js";
import { SidePanel } from "./side-panel.js";
import { StatusText } from "./status.js";

function Demo({
  panelOpen = true,
  sidebarOpen = true,
}: {
  panelOpen?: boolean;
  sidebarOpen?: boolean;
}) {
  const [open, setOpen] = useState(panelOpen);
  const [width, setWidth] = useState(400);
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Threads"
      defaultSidebarOpen={sidebarOpen}
      commands={SAMPLE_COMMANDS}
      onTogglePanel={() => setOpen((value) => !value)}
      sidebar={
        <ul className="grid gap-1 text-ui">
          <li className="rounded-md px-2 py-1 tint-selected font-medium">
            What is the liability cap?
          </li>
          <li className="rounded-md px-2 py-1">Termination for convenience</li>
        </ul>
      }
      panel={
        open && (
          <SidePanel
            title="Sources"
            width={width}
            onWidthChange={setWidth}
            onClose={() => setOpen(false)}
          >
            <p className="font-medium">Master services agreement.pdf</p>
            <p className="text-fg-muted">Page 14</p>
            <StatusText tone="verified">Verified</StatusText>
          </SidePanel>
        )
      }
    >
      <article className="mx-auto grid max-w-[880px] gap-4 px-8 py-6">
        <h1 className="text-title font-semibold">What is the liability cap?</h1>
        <p className="max-w-[72ch] text-prose">
          The cap is the fees paid in the twelve months before the claim
          <CitationMarker
            evidence={{
              n: 1,
              status: "ok",
              documentName: "Master services agreement.pdf",
              page: 14,
              quote: "shall not exceed the fees paid in the 12 months before the claim",
            }}
            onOpen={() => setOpen(true)}
          />
          .
        </p>
        <p className="text-caption text-fg-muted">
          ⌘K search · ? shortcuts · ⌘B sidebar · ⌘/ panel
        </p>
      </article>
    </AppShell>
  );
}

const meta = {
  title: "Shell/App shell",
  component: Demo,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithPanel: Story = {};
export const PanelClosed: Story = { args: { panelOpen: false } };
export const SidebarCollapsed: Story = { args: { sidebarOpen: false } };
