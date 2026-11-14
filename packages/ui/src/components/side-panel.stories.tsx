import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { PANEL_MAX, PANEL_MIN, SidePanel } from "./side-panel.js";

function Resizable({ start }: { start: number }) {
  const [width, setWidth] = useState(start);
  return (
    <div className="flex h-[480px] justify-end border border-border">
      <SidePanel title="Sources" width={width} onWidthChange={setWidth} onClose={fn()}>
        <p className="text-fg-muted">Drag the left edge, or focus it and use the arrow keys.</p>
        <p className="mt-2 text-caption text-fg-muted tabular-nums">{width} px wide</p>
      </SidePanel>
    </div>
  );
}

const meta = {
  title: "Kit/Side panel",
  component: SidePanel,
  args: { title: "Sources", width: 400, onClose: fn(), children: "Panel content" },
  render: (args) => <Resizable start={args.width} />,
} satisfies Meta<typeof SidePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Narrowest: Story = { args: { width: PANEL_MIN } };
export const Widest: Story = { args: { width: PANEL_MAX } };
export const FixedWidth: Story = {
  render: (args) => (
    <div className="flex h-[480px] justify-end border border-border">
      <SidePanel {...args}>Nothing here can be resized.</SidePanel>
    </div>
  ),
};
