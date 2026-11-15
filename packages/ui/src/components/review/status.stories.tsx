import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "../status.js";
import { FindingStatusText, GapSeverityText, SuggestionStatusText } from "./status.js";

const meta = {
  title: "Review/Status",
  component: FindingStatusText,
  args: { status: "not_acceptable" },
} satisfies Meta<typeof FindingStatusText>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Findings: Story = {
  render: () => (
    <div className="grid gap-2">
      {(["acceptable", "needs_review", "not_acceptable", "not_found", "skipped"] as const).map(
        (s) => (
          <FindingStatusText key={s} status={s} />
        ),
      )}
    </div>
  ),
};
export const Suggestions: Story = {
  render: () => (
    <div className="grid gap-2">
      {(["pending", "applied", "dismissed", "superseded", "anchor_failed"] as const).map((s) => (
        <SuggestionStatusText key={s} status={s} />
      ))}
    </div>
  ),
};
export const Severity: Story = {
  render: () => (
    <div className="grid gap-2">
      {(["high", "medium", "low"] as const).map((s) => (
        <GapSeverityText key={s} severity={s} />
      ))}
    </div>
  ),
};
export const Loading: Story = { render: () => <Skeleton className="h-5 w-28" /> };
