import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AgentShareForm, AgentShareFormSkeleton } from "./agent-share-form.js";

const meta = {
  title: "Agents/Share form",
  component: AgentShareForm,
  args: {
    grants: [
      { id: "g1", principalType: "user", label: "Sam Lee", level: "edit" },
      { id: "g2", principalType: "group", label: "Commercial team", level: "run" },
    ],
    requests: [
      {
        id: "r1",
        principalType: "workspace",
        label: "Everyone in the workspace",
        level: "run",
        status: "pending",
        reason: null,
      },
    ],
    policy: { individual: false, group: false, workspace: true },
    search: async () => [
      { principalType: "user", principalId: "u3", label: "Alex Kim" },
      { principalType: "group", principalId: "g9", label: "Disputes" },
    ],
    onAdd: fn(),
    onRemove: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof AgentShareForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Shared: Story = {};
export const OnlyMe: Story = { args: { grants: [], requests: [] } };
export const PendingNotice: Story = {
  args: { notice: "Pending approval: an admin will review this share." },
};
export const Cooldown: Story = {
  args: { error: "That request was denied recently. Try again after 7 days." },
};
export const Loading: Story = { render: () => <AgentShareFormSkeleton /> };
