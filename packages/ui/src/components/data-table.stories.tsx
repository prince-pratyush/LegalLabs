import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText } from "lucide-react";
import { fn } from "storybook/test";
import { DataTable, type TableColumn } from "./data-table.js";
import { EmptyState } from "./empty-state.js";
import { StatusText } from "./status.js";

type Doc = { id: string; name: string; pages: number; fee: number; added: string; ok: boolean };

const docs = (count: number): Doc[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    name: `Supplier agreement ${String(i + 1).padStart(5, "0")}.pdf`,
    pages: ((i * 7) % 90) + 1,
    fee: ((i * 7919) % 500_000) + 1_000,
    added: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString().slice(0, 10),
    ok: i % 4 !== 0,
  }));

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const columns: TableColumn<Doc>[] = [
  { id: "name", header: "Document", cell: (d) => d.name, sortValue: (d) => d.name },
  {
    id: "pages",
    header: "Pages",
    cell: (d) => d.pages,
    sortValue: (d) => d.pages,
    align: "end",
    width: 96,
  },
  {
    id: "fee",
    header: "Annual fee",
    cell: (d) => money.format(d.fee),
    sortValue: (d) => d.fee,
    align: "end",
    width: 140,
  },
  { id: "added", header: "Added", cell: (d) => d.added, sortValue: (d) => d.added, width: 120 },
  {
    id: "check",
    header: "Fee check",
    width: 140,
    cell: (d) => (
      <StatusText tone={d.ok ? "verified" : "flagged"}>{d.ok ? "Verified" : "Flagged"}</StatusText>
    ),
  },
];

const meta = {
  title: "Domain/Table",
  component: DataTable<Doc>,
  args: {
    label: "Documents",
    columns,
    rows: docs(40),
    getRowId: (d: Doc) => d.id,
    onActivate: fn(),
    empty: (
      <EmptyState
        icon={FileText}
        title="No documents yet"
        action={{ label: "Upload a document", onClick: fn() }}
      />
    ),
  },
} satisfies Meta<typeof DataTable<Doc>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const TenThousandRows: Story = { args: { rows: docs(10_000) } };
export const Loading: Story = { args: { loading: true, rows: [] } };
export const Empty: Story = { args: { rows: [] } };
