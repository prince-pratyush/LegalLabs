import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunDialog, type RunEstimate } from "./run-dialog.js";

const ESTIMATE: RunEstimate = {
  cells: 10,
  locked_skipped: 0,
  verified_skipped: 0,
  est_cost_usd: 0,
  est_minutes: 0.5,
};

const meta = {
  title: "Review tables/Run dialog",
  component: RunDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    columnLabel: "Governing law",
    rowCount: 1204,
    estimate: async () => ESTIMATE,
    onRun: () => {},
  },
} satisfies Meta<typeof RunDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DryRunByDefault: Story = {};

export const SmallTable: Story = { args: { rowCount: 8 } };

export const Rerun: Story = {
  args: {
    rerun: true,
    estimate: async () => ({ ...ESTIMATE, cells: 1100, verified_skipped: 92, est_minutes: 9 }),
  },
};

export const Loading: Story = { args: { estimate: () => new Promise(() => {}) } };
