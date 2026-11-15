import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { sampleRuleChoices } from "./fixtures.js";
import { applyEvent, startProgress } from "./order.js";
import { ReviewProgress, ReviewProgressSkeleton } from "./review-progress.js";

const [a, b, c] = sampleRuleChoices.map((r) => r.id);
const midway = [
  { type: "review.rule_started", rule_id: a },
  { type: "review.rule_finished", rule_id: a, status: "not_acceptable" },
  { type: "review.rule_started", rule_id: b },
  { type: "review.rule_finished", rule_id: b, status: "acceptable" },
  { type: "review.rule_started", rule_id: c },
  { type: "review.gap_pass_started" },
].reduce(applyEvent, startProgress(sampleRuleChoices.map((r) => r.id)));

const meta = {
  title: "Review/Progress",
  component: ReviewProgress,
  args: { rules: sampleRuleChoices, state: midway, elapsedMs: 100_000, onCancel: fn() },
  decorators: [(Story) => <div className="w-[380px]">{Story()}</div>],
} satisfies Meta<typeof ReviewProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};
export const Cancelling: Story = { args: { cancelling: true } };
export const Cancelled: Story = {
  args: { state: applyEvent(midway, { type: "status", status: "cancelled" }) },
};
export const Failed: Story = {
  args: {
    state: applyEvent(midway, {
      type: "error",
      message: "No model could run the review.",
      retryable: false,
    }),
  },
};
export const Loading: Story = { render: () => <ReviewProgressSkeleton /> };
