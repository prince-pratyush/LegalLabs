import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "../status.js";
import { FilterPanel } from "./filter-panel.js";

const meta = {
  title: "Review tables/Filter panel",
  component: FilterPanel,
  args: { columnLabel: "Governing law", value: null, onApply: () => {} },
  decorators: [(Story) => <div className="w-80">{<Story />}</div>],
} satisfies Meta<typeof FilterPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Applied: Story = {
  args: {
    value: { status: ["null", "error"], flag: ["red"], verified: false, contains: "Delaware" },
  },
};

// The panel has no async work; this is what the page shows while columns load.
export const Loading: Story = {
  render: () => (
    <section aria-busy="true" aria-label="Loading filters" className="grid gap-2">
      <Skeleton className="h-8" />
      <Skeleton className="h-16" />
      <Skeleton className="h-12" />
    </section>
  ),
};
