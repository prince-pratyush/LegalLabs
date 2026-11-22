import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { NudgeChip } from "./nudge-chip.js";

const meta = {
  title: "Agents/Nudge chip",
  component: NudgeChip,
  args: { title: "NDA first pass", onRun: fn(), onDismiss: fn() },
  decorators: [(Story) => <div className="max-w-xl">{Story()}</div>],
} satisfies Meta<typeof NudgeChip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Suggestion: Story = {};
export const LongTitle: Story = {
  args: { title: "Quarterly regulatory change digest for financial services clients" },
};
