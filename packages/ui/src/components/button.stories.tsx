import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "./button.js";

const meta = {
  title: "Kit/Button",
  component: Button,
  args: { children: "Ask" },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: "secondary", children: "Upload" } };
export const Quiet: Story = { args: { variant: "quiet", children: "Sign out" } };
export const Destructive: Story = {
  args: {
    variant: "destructive",
    children: (
      <>
        <Trash2 aria-hidden /> Delete
      </>
    ),
  },
};
export const Disabled: Story = { args: { disabled: true } };
export const Small: Story = { args: { size: "sm", children: "New question" } };
export const IconOnly: Story = {
  args: { size: "icon", variant: "secondary", "aria-label": "Add", children: <Plus aria-hidden /> },
};
export const AsLink: Story = {
  args: { asChild: true, variant: "secondary", children: <a href="#docs">Read the guide</a> },
};
export const Focused: Story = {
  play: ({ canvasElement }) => canvasElement.querySelector("button")?.focus(),
};
