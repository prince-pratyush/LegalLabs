import type { Meta, StoryObj } from "@storybook/react-vite";
import { TableList, type TableSummary } from "./table-list.js";

const TABLES: TableSummary[] = [
  {
    id: "t1",
    name: "DD table — Falcon",
    source_kind: "vault",
    starred: true,
    updated_at: "2026-11-15T09:00:00Z",
    stats: { rows: 1204, columns: 14 },
  },
  {
    id: "t2",
    name: "NDA sweep",
    source_kind: "uploads",
    starred: false,
    updated_at: "2026-11-14T16:30:00Z",
    stats: { rows: 38, columns: 6 },
  },
];

const noop = () => {};
const meta = {
  title: "Review tables/Table list",
  component: TableList,
  args: {
    tables: TABLES,
    starredOnly: false,
    onStarredOnlyChange: noop,
    onStar: noop,
    onOpen: noop,
    onCreate: noop,
  },
} satisfies Meta<typeof TableList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Tables: Story = {};
export const StarredOnly: Story = { args: { starredOnly: true } };
export const Empty: Story = { args: { tables: [] } };
export const NoStarred: Story = {
  args: { tables: [TABLES[1] as TableSummary], starredOnly: true },
};
export const Loading: Story = { args: { tables: [], loading: true } };
