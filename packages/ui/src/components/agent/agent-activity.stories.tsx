import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AgentActivity, AgentActivitySkeleton } from "./agent-activity.js";

const meta = {
  title: "Agents/Activity",
  component: AgentActivity,
  args: {
    runs: [
      {
        id: "r1",
        status: "done",
        startedAt: "2026-11-20T09:00:00Z",
        finishedAt: "2026-11-20T09:02:14Z",
        costUsd: 0.0421,
        testMode: false,
        errorCode: null,
      },
      {
        id: "r2",
        status: "awaiting_input",
        startedAt: "2026-11-21T08:00:00Z",
        finishedAt: null,
        costUsd: 0.003,
        testMode: true,
        errorCode: null,
      },
      {
        id: "r3",
        status: "failed",
        startedAt: "2026-11-19T08:00:00Z",
        finishedAt: "2026-11-19T08:00:20Z",
        costUsd: 0,
        testMode: false,
        errorCode: "NONINTERACTIVE_INPUT_REQUIRED",
      },
    ],
    nextRunAt: "2026-11-24T22:00:00Z",
    onOpen: fn(),
  },
} satisfies Meta<typeof AgentActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Runs: Story = {};
export const NoRuns: Story = { args: { runs: [], nextRunAt: null } };
export const Loading: Story = { render: () => <AgentActivitySkeleton /> };
