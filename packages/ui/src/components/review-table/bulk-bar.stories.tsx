import type { Meta, StoryObj } from "@storybook/react-vite";
import { BulkBar } from "./bulk-bar.js";

const meta = {
  title: "Review tables/Bulk bar",
  component: BulkBar,
  args: {
    cellCount: 312,
    columnCount: 2,
    estimate: async () => ({ est_cost_usd: 1.8, est_minutes: 5.4 }),
    onConfirm: () => {},
    onClear: () => {},
  },
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="h-40">{<Story />}</div>],
} satisfies Meta<typeof BulkBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Actions: Story = {};

const clickRerun = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  [...canvasElement.querySelectorAll("button")].find((b) => b.textContent === "Re-run")?.click();
};

export const ConfirmRerun: Story = { play: clickRerun };

// The confirm waits forever, so the sheet stays busy.
export const Loading: Story = {
  args: { onConfirm: () => new Promise(() => {}) },
  play: async (context) => {
    await clickRerun(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    [...context.canvasElement.querySelectorAll("button")]
      .find((b) => b.textContent === "Confirm")
      ?.click();
  },
};
