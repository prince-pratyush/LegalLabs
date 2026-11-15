import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { summary } from "./fixtures.js";
import { PlaybookTable } from "./playbook-table.js";

const meta = {
  title: "Playbook/Playbook table",
  component: PlaybookTable,
  args: {
    rows: Array.from({ length: 8 }, (_, i) => summary(i)),
    onOpen: fn(),
    onCreate: fn(),
    height: 360,
  },
} satisfies Meta<typeof PlaybookTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { args: { rows: [] } };
export const NoMatches: Story = { args: { rows: [], filtered: true } };
export const Loading: Story = { args: { rows: [], loading: true } };
