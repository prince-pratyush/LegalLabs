import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelBadge, ModelBadgeSkeleton } from "./model-badge.js";

const meta = {
  title: "Thread/Model badge",
  component: ModelBadge,
  args: {
    model: "anthropic/claude-haiku-5-5",
    inputTokens: 11_200,
    outputTokens: 1_280,
    costUsd: 0.09,
    scope: "Attached files",
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof ModelBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Paid: Story = {};
export const LocalIsFree: Story = { args: { model: "ollama/qwen3:4b-instruct", costUsd: 0 } };
export const Fallback: Story = { args: { fallbackFrom: "google/gemini-3.6-flash" } };
export const NoModel: Story = {
  args: { model: null, inputTokens: 0, outputTokens: 0, costUsd: 0 },
};
export const UnknownCost: Story = { args: { costUsd: null } };
export const Loading: Story = { render: () => <ModelBadgeSkeleton /> };
