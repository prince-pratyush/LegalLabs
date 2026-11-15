import type { Meta, StoryObj } from "@storybook/react-vite";
import { ColumnHeader, ColumnHeaderSkeleton } from "./column-header.js";
import { sampleColumn } from "./fixtures.js";

const noop = () => {};
const handlers = {
  onRun: noop,
  onRerun: noop,
  onRunRemaining: noop,
  onEditPrompt: noop,
  onStop: noop,
  onSort: noop,
  onFilter: noop,
  onDelete: noop,
};

const meta = {
  title: "Review tables/Column header",
  component: ColumnHeader,
  args: { column: sampleColumn(), rowCount: 1204, ...handlers },
  decorators: [
    (Story) => (
      <div className="flex h-14 w-64 items-center border border-border bg-bg-subtle px-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ColumnHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotRun: Story = {
  args: {
    column: sampleColumn({
      state: "pending",
      progress: { done: 0, total: 1204, null: 0, error: 0, cost_usd: 0 },
    }),
  },
};

export const Running: Story = {
  args: {
    column: sampleColumn({
      state: "running",
      progress: { done: 312, total: 1204, null: 4, error: 1, cost_usd: 0.42 },
    }),
  },
};

export const DryRun: Story = {
  args: {
    column: sampleColumn({
      state: "partial",
      dry_run: true,
      progress: { done: 10, total: 10, null: 1, error: 0, cost_usd: 0 },
    }),
  },
};

export const SortedAndFiltered: Story = { args: { sort: "desc", filtered: true } };

export const Loading: Story = {
  render: () => (
    <section aria-busy="true" aria-label="Loading column">
      <ColumnHeaderSkeleton />
    </section>
  ),
};
