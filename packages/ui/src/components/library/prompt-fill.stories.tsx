import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { PromptFill, PromptFillSkeleton } from "./prompt-fill.js";

const meta = {
  title: "Library/Prompt fill",
  component: PromptFill,
  args: {
    text: "Review the {{agreement}} for {{counterparty}}. List every clause that is one-sided, with a fairer wording.",
    onUse: fn(),
    onCancel: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof PromptFill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithVariables: Story = {};
export const NoVariables: Story = {
  args: { text: "Summarise this document in five bullet points." },
};
export const Loading: Story = { render: () => <PromptFillSkeleton /> };
