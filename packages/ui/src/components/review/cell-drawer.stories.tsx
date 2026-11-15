import type { Meta, StoryObj } from "@storybook/react-vite";
import { CellDrawer, type DrawerDetail } from "./cell-drawer.js";
import { sampleCell } from "./fixtures.js";

const noop = () => {};

const DONE: DrawerDetail = {
  cell: {
    ...sampleCell({ verified_at: "2026-11-15T09:00:00Z" }),
    reasoning: "Section 14.2 says the agreement is governed by the laws of Delaware.",
    looked_at: null,
    model: "qwen3:4b-instruct",
    cost_usd: 0,
  },
  citations: [
    {
      id: "q1",
      ordinal: 1,
      document_name: "MSA_Acme.pdf",
      page: 14,
      quote: "This Agreement shall be governed by the laws of the State of Delaware.",
      status: "ok",
      open_url: "#/documents/d1?page=14",
    },
    {
      id: "q2",
      ordinal: 2,
      document_name: "MSA_Acme.pdf",
      page: 3,
      quote: "governed by Delaware law",
      status: "mismatch",
      open_url: null,
    },
  ],
  history: [
    { at: "2026-11-15T08:59:00Z", actor_id: null, field: "run", old: null, new: "done" },
    { at: "2026-11-15T09:00:00Z", actor_id: "u1", field: "verified", old: false, new: true },
  ],
};

const NULL: DrawerDetail = {
  cell: {
    ...sampleCell({ status: "null", value_text: null, citation_count: 0 }),
    reasoning: "No termination fee is stated.",
    looked_at: {
      documents: [{ document_id: "d1", pages: [2, 9, 10] }],
      queries: ["termination fee", "break fee"],
      chunks_read: 6,
      note: "Read the termination and fees sections.",
    },
    model: "qwen3:4b-instruct",
    cost_usd: 0,
  },
  citations: [],
  history: [],
};

const meta = {
  title: "Review tables/Cell drawer",
  component: CellDrawer,
  args: {
    columnLabel: "Governing law",
    documentName: "MSA_Acme.pdf",
    detail: DONE,
    onClose: noop,
    onRerun: noop,
    onVerify: noop,
    onFlag: noop,
    onLock: noop,
    onSave: noop,
    onOpenCitation: noop,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CellDrawer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Verified: Story = {};

export const WhereILooked: Story = { args: { detail: NULL, columnLabel: "Termination fee" } };

export const Locked: Story = {
  args: { detail: { ...DONE, cell: { ...DONE.cell, locked: true, flag_color: "red" } } },
};

export const ErrorCell: Story = {
  args: {
    detail: {
      ...DONE,
      cell: { ...DONE.cell, status: "error", error_code: "CITATION_UNVERIFIED", value_text: null },
      citations: [],
    },
  },
};

export const Loading: Story = { args: { detail: null } };
