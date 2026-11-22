import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AgentList, type AgentRow } from "./agent-list.js";

const rows: AgentRow[] = [
  {
    id: "a1",
    title: "NDA first pass",
    description: "Reviews inbound NDAs against the firm playbook and drafts a summary email.",
    practiceAreas: ["Commercial"],
    status: "live",
    access: "full",
    mine: true,
    runs: 12,
    schedule: null,
  },
  {
    id: "a2",
    title: "Weekly regulatory digest",
    description: "Summarises new guidance from the regulators we track.",
    practiceAreas: ["Regulatory", "Financial services"],
    status: "live",
    access: "run",
    mine: false,
    runs: 1,
    schedule: { paused: false, nextRunAt: "2026-11-24T22:00:00.000Z" },
  },
  {
    id: "a3",
    title: "Untitled agent",
    description: "",
    practiceAreas: [],
    status: "draft",
    access: "edit",
    mine: false,
    runs: 0,
    schedule: { paused: true, nextRunAt: null },
  },
];

const meta = {
  title: "Agents/List",
  component: AgentList,
  args: { rows, onOpen: fn(), onCreate: fn() },
} satisfies Meta<typeof AgentList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = {};
export const Empty: Story = { args: { rows: [] } };
export const NoMatch: Story = { args: { rows: [], filtered: true } };
export const Loading: Story = { args: { rows: [], loading: true } };
