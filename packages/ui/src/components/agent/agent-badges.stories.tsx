import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccessBadge, AgentStatusBadge, ScheduleBadge } from "./agent-badges.js";

const meta = {
  title: "Agents/Badges",
  component: AccessBadge,
  args: { level: "run" },
} satisfies Meta<typeof AccessBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EveryLevel: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <AccessBadge level="run" />
      <AccessBadge level="view" />
      <AccessBadge level="edit" />
      <AccessBadge level="full" />
    </div>
  ),
};
export const Statuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <AgentStatusBadge status="live" />
      <AgentStatusBadge status="draft" />
      <ScheduleBadge paused={false} />
      <ScheduleBadge paused />
    </div>
  ),
};
