import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton, StatusDot, StatusText, type Tone } from "./status.js";

const LABELS: Record<Tone, string> = {
  verified: "Verified",
  flagged: "Flagged",
  warning: "Not verified",
  failed: "Failed",
  locked: "Locked",
  running: "Reading page 4 of 10",
  external: "Shared outside the firm",
};

const meta = {
  title: "Kit/Status",
  component: StatusText,
  args: { tone: "verified", children: "Verified" },
} satisfies Meta<typeof StatusText>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EveryTone: Story = {
  render: () => (
    <ul className="grid gap-2">
      {(Object.keys(LABELS) as Tone[]).map((tone) => (
        <li key={tone}>
          <StatusText tone={tone}>{LABELS[tone]}</StatusText>
        </li>
      ))}
    </ul>
  ),
};

export const DotsWithLabels: Story = {
  render: () => (
    <ul className="grid gap-2 text-ui">
      {(Object.keys(LABELS) as Tone[]).map((tone) => (
        <li key={tone} className="flex items-center gap-2">
          <StatusDot tone={tone} />
          {LABELS[tone]}
        </li>
      ))}
    </ul>
  ),
};

export const Loading: Story = {
  render: () => (
    <section aria-busy="true" aria-label="Loading the thread" className="grid max-w-md gap-2">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-1/2" />
    </section>
  ),
};
