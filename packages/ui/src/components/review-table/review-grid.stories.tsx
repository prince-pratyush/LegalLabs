import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { sampleCellFor, sampleColumn, sampleColumns, sampleRows } from "./fixtures.js";
import { type CellRef, ReviewGrid } from "./review-grid.js";

const NOW = Date.parse("2026-11-15T10:00:30Z");

function Stateful(props: Partial<ComponentProps<typeof ReviewGrid>>) {
  const [active, setActive] = useState<CellRef | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <ReviewGrid
      label="DD table"
      rows={sampleRows(40)}
      columns={sampleColumns}
      getCell={sampleCellFor}
      active={active}
      onActiveChange={setActive}
      selected={selected}
      onSelectionChange={setSelected}
      onEdit={() => {}}
      onRetry={() => {}}
      now={NOW}
      height={420}
      empty={<p className="text-fg-muted">No documents in this table yet.</p>}
      {...props}
    />
  );
}

const meta = {
  title: "Review tables/Grid",
  component: Stateful,
} satisfies Meta<typeof Stateful>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedStates: Story = {};

// 10,000 rows by 200 columns: only what's on screen is in the DOM.
const WIDE = Array.from({ length: 200 }, (_, i) =>
  sampleColumn({ id: `w${i}`, label: `Column ${i + 1}` }),
);
export const TenThousandRows: Story = {
  args: {
    rows: sampleRows(10_000),
    columns: WIDE,
    getCell: (rowId, columnId) => sampleCellFor(rowId, `k${(Number(columnId.slice(1)) % 3) + 1}`),
  },
};

export const Empty: Story = { args: { rows: [] } };

export const Loading: Story = { args: { rows: [], loading: true } };
