import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { HistoryRow } from "./history.js";
import { HistoryTable } from "./history-table.js";

const NOW = new Date("2026-11-14T12:00:00Z");

const ROWS: HistoryRow[] = [
  {
    id: "1",
    title: "What is the liability cap in the MSA?",
    type: "assist",
    matter: "Falcon",
    documentCount: 2,
    model: "ollama/qwen3:4b-instruct",
    costUsd: 0,
    lastActivityAt: "2026-11-14T09:12:00Z",
    status: "done",
    favourite: true,
    restricted: false,
  },
  {
    id: "2",
    title: "Change-of-control review across the data room",
    type: "deep_analysis",
    matter: "Falcon",
    documentCount: 120,
    model: "anthropic/claude-haiku-5-5",
    costUsd: 0.4213,
    lastActivityAt: "2026-11-13T15:40:00Z",
    status: "needs_input",
    favourite: false,
    restricted: false,
  },
  {
    id: "3",
    title: "Hidden",
    type: "draft",
    matter: null,
    documentCount: 1,
    model: null,
    costUsd: null,
    lastActivityAt: "2026-10-02T08:00:00Z",
    status: "done",
    favourite: false,
    restricted: true,
  },
  {
    id: "4",
    title: "Board minutes summary",
    type: "assist",
    matter: null,
    documentCount: 14,
    model: "anthropic/claude-haiku-5-5",
    costUsd: 0.0112,
    lastActivityAt: "2026-09-21T08:00:00Z",
    status: "failed",
    favourite: false,
    restricted: false,
  },
];

const meta = {
  title: "Thread/History table",
  component: HistoryTable,
  args: { rows: ROWS, now: NOW, onOpen: fn(), onFavourite: fn(), onStart: fn() },
} satisfies Meta<typeof HistoryTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { args: { rows: [] } };
export const Loading: Story = { args: { rows: [], loading: true } };
