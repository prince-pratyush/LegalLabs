import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText, SearchX, ShieldAlert } from "lucide-react";
import { fn } from "storybook/test";
import { EmptyState } from "./empty-state.js";

const meta = {
  title: "Kit/Empty state",
  component: EmptyState,
  args: {
    icon: FileText,
    title: "No documents yet",
    description: "Upload a PDF, TXT or Markdown file to ask questions about it.",
    action: { label: "Upload a document", onClick: fn() },
  },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OneAction: Story = {};
export const WithSecondary: Story = {
  args: {
    icon: SearchX,
    title: "No results for “indemnity cap”",
    description: "Nothing in the chosen documents matched.",
    action: { label: "Search the whole vault", onClick: fn() },
    secondary: { label: "Clear search", onClick: fn() },
  },
};
export const AccessDenied: Story = {
  args: {
    icon: ShieldAlert,
    title: "You can't open this vault",
    description: "Ben Ito owns it.",
    action: { label: "Request access", onClick: fn() },
  },
};
