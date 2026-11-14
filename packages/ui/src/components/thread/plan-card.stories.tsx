import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { PlanCard, PlanCardSkeleton } from "./plan-card.js";

const meta = {
  title: "Thread/Plan card",
  component: PlanCard,
  args: {
    steps: [
      {
        id: "1",
        title: "Find every assignment and change-of-control clause",
        sources: ["Falcon data room"],
        estimate: { docs: 120, pages: 3020 },
      },
      {
        id: "2",
        title: "Check consent requirements against the deal timeline",
        sources: ["Falcon data room", "Disclosure letter.docx"],
        estimate: { docs: 12, pages: 140 },
      },
      {
        id: "3",
        title: "Write the report with sources",
        sources: [],
        estimate: { docs: 0, pages: 0 },
      },
    ],
    costLow: 0.4,
    costHigh: 1.1,
    onApprove: fn(),
    onEdit: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof PlanCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AwaitingApproval: Story = {};
export const Busy: Story = { args: { busy: true } };
export const OneStep: Story = {
  args: { steps: [{ id: "1", title: "Summarise", sources: [], estimate: { docs: 1, pages: 3 } }] },
};
export const Loading: Story = { render: () => <PlanCardSkeleton /> };
