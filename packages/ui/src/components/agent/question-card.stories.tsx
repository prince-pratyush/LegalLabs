import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { QuestionCard } from "./question-card.js";

const meta = {
  title: "Agents/Question card",
  component: QuestionCard,
  args: {
    text: "Which playbook should the agent compare NDAs against?",
    options: [
      { id: "firm", label: "Firm NDA playbook" },
      { id: "client", label: "Client's own positions" },
    ],
    allowText: true,
    allowSkip: true,
    onAnswer: fn(),
  },
  decorators: [(Story) => <div className="max-w-xl">{Story()}</div>],
} satisfies Meta<typeof QuestionCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithOptions: Story = {};
export const Builder: Story = { args: { skipLabel: "Skip remaining" } };
export const OptionsOnly: Story = { args: { allowText: false, allowSkip: false } };
export const Sending: Story = { args: { busy: true } };
export const Failed: Story = { args: { error: "That run has already finished." } };
