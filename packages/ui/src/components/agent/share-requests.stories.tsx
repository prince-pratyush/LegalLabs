import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ApprovalSwitches, ShareRequestQueue } from "./share-requests.js";

const meta = {
  title: "Agents/Share requests",
  component: ShareRequestQueue,
  args: {
    requests: [
      {
        id: "q1",
        agentTitle: "NDA first pass",
        principalLabel: "Everyone in the workspace",
        level: "run",
        requestedBy: "Sam Lee",
        createdAt: "2026-11-20T09:00:00Z",
        status: "pending",
        reason: null,
      },
      {
        id: "q2",
        agentTitle: "Lease abstraction",
        principalLabel: "Real estate group",
        level: "view",
        requestedBy: "Alex Kim",
        createdAt: "2026-11-19T09:00:00Z",
        status: "denied",
        reason: "Still in testing.",
      },
    ],
    onAccept: fn(),
    onDeny: fn(),
  },
  decorators: [(Story) => <div className="max-w-xl">{Story()}</div>],
} satisfies Meta<typeof ShareRequestQueue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Queue: Story = {};
export const Empty: Story = { args: { requests: [] } };
export const Switches: Story = {
  render: () => (
    <ApprovalSwitches
      value={{ individual: false, group: false, workspace: true }}
      onChange={fn()}
    />
  ),
};
