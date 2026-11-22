import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { blankSchedule, ScheduleForm } from "./schedule-form.js";

const zones = ["Australia/Sydney", "Europe/London", "America/New_York", "UTC"];

const meta = {
  title: "Agents/Schedule form",
  component: ScheduleForm,
  args: {
    initial: blankSchedule("Australia/Sydney"),
    zones,
    matters: [{ id: "m1", name: "Falcon acquisition" }],
    onSave: fn(),
    onRemove: fn(),
  },
  decorators: [(Story) => <div className="max-w-md">{Story()}</div>],
} satisfies Meta<typeof ScheduleForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const New: Story = {};
export const Active: Story = {
  args: {
    initial: { ...blankSchedule("Europe/London"), rule: "every_n_days", n: 3, email: true },
    state: { paused: false, reason: null, nextRunAt: "2026-11-24T09:00:00Z" },
  },
};
export const Paused: Story = {
  args: { state: { paused: true, reason: "You no longer have access", nextRunAt: null } },
};
export const Refused: Story = { args: { error: "Save the agent before scheduling it." } };
