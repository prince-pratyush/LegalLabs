import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";

const meta = {
  title: "Kit/Confirm dialog",
  component: ConfirmDialog,
  args: {
    title: "Delete this thread?",
    description: "The questions and answers go to the recycle bin for 30 days.",
    confirmLabel: "Delete thread",
    destructive: true,
    onConfirm: fn(),
    trigger: <Button variant="destructive">Delete thread</Button>,
  },
} satisfies Meta<typeof ConfirmDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const OpenDestructive: Story = { args: { defaultOpen: true } };
export const OpenNeutral: Story = {
  args: {
    defaultOpen: true,
    destructive: false,
    title: "Send to the client?",
    description: "Ana at Acme will get an email with a link to this draft.",
    confirmLabel: "Send",
    trigger: <Button>Send</Button>,
  },
};
