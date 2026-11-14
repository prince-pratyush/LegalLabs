import type { Meta, StoryObj } from "@storybook/react-vite";
import { PanelLeft } from "lucide-react";
import { Button } from "./button.js";
import { Tooltip } from "./tooltip.js";

const meta = {
  title: "Kit/Tooltip",
  component: Tooltip,
  args: {
    content: "Show sidebar",
    shortcut: "⌘B",
    children: (
      <Button variant="quiet" size="icon" aria-label="Sidebar">
        <PanelLeft aria-hidden />
      </Button>
    ),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OnHover: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const WithoutShortcut: Story = {
  render: () => (
    <Tooltip content="Upload a document" defaultOpen>
      <Button variant="secondary">Upload</Button>
    </Tooltip>
  ),
};
