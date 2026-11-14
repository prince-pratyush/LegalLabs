import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunProgress, RunProgressSkeleton } from "./run-progress.js";

const meta = {
  title: "Thread/Run progress",
  component: RunProgress,
  args: {
    steps: [
      { id: "1", title: "Plan the review", status: "done", costUsd: 0.01 },
      { id: "2", title: "Read leases 1-40", status: "done", detail: "40 files", costUsd: 0.12 },
      { id: "3", title: "Read leases 41-80", status: "running", detail: "Reading Lease 52.pdf" },
      { id: "4", title: "Check gaps", status: "queued" },
      { id: "5", title: "Write the report", status: "queued" },
    ],
    coverage: { docsRead: 52, docsInScope: 120, pagesRead: 1310, pagesInScope: 3020 },
  },
} satisfies Meta<typeof RunProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};
export const WithFailureAndSkip: Story = {
  args: {
    steps: [
      { id: "1", title: "Plan", status: "done" },
      { id: "2", title: "Read partition A", status: "failed", detail: "Model unavailable" },
      { id: "3", title: "Read partition B", status: "skipped" },
    ],
  },
};
export const NoCoverage: Story = {
  render: ({ steps }) => <RunProgress steps={steps} />,
};
export const Loading: Story = { render: () => <RunProgressSkeleton /> };
