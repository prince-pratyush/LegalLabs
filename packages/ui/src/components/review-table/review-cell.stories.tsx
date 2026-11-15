import type { Meta, StoryObj } from "@storybook/react-vite";
import { sampleCell } from "./fixtures.js";
import { ReviewCell, ReviewCellSkeleton } from "./review-cell.js";
import type { GridCell } from "./types.js";

const NOW = Date.parse("2026-11-15T10:00:30Z");

const STATES: [string, GridCell | undefined][] = [
  ["Empty", undefined],
  ["Queued", sampleCell({ status: "queued", value_text: null, citation_count: 0 })],
  ["Running", sampleCell({ status: "running", value_text: null, citation_count: 0 })],
  ["Done", sampleCell()],
  ["Verified", sampleCell({ verified_at: "2026-11-15T10:00:00Z" })],
  ["Flagged", sampleCell({ flag_color: "orange" })],
  ["Locked", sampleCell({ locked: true })],
  ["Edited", sampleCell({ edited_by: "u1", value_text: "New York" })],
  ["Stale", sampleCell({ status: "stale" })],
  ["Error", sampleCell({ status: "error", error_code: "MODEL_ERROR", value_text: null })],
  ["Null", sampleCell({ status: "null", value_text: null, citation_count: 0 })],
  [
    "Verified, flagged and locked",
    sampleCell({ verified_at: "2026-11-15T10:00:00Z", flag_color: "purple", locked: true }),
  ],
];

const meta = {
  title: "Review tables/Cell",
  component: ReviewCell,
  args: { cell: sampleCell(), now: NOW },
} satisfies Meta<typeof ReviewCell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EveryState: Story = {
  render: () => (
    <dl className="grid w-96 grid-cols-[10rem_1fr] gap-2 text-dense">
      {STATES.map(([name, cell]) => (
        <div key={name} className="contents">
          <dt className="text-fg-muted">{name}</dt>
          <dd className="min-w-0">
            <ReviewCell cell={cell} now={NOW} onRetry={() => {}} onLooked={() => {}} />
          </dd>
        </div>
      ))}
    </dl>
  ),
};

export const Loading: Story = {
  render: () => (
    <section aria-busy="true" aria-label="Loading cell" className="w-48">
      <ReviewCellSkeleton />
    </section>
  ),
};
