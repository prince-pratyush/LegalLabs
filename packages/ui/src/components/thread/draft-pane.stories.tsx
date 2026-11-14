import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { DraftPane, DraftPaneSkeleton } from "./draft-pane.js";

const BODY =
  "# Advice note\n\nThe Supplier's liability is capped at the fees paid in the 12 months before the claim.\n";

const meta = {
  title: "Thread/Draft pane",
  component: DraftPane,
  args: {
    title: "Liability advice note",
    kind: "editor",
    versions: [
      { no: 1, createdAt: "2026-11-14T09:00:00Z", author: "assistant" },
      { no: 2, createdAt: "2026-11-14T09:05:00Z", author: "user" },
      { no: 3, createdAt: "2026-11-14T09:10:00Z", author: "assistant" },
    ],
    versionNo: 3,
    onVersion: fn(),
    showEdits: false,
    onShowEdits: fn(),
    ops: [
      { op: "equal", text: "The Supplier's liability is capped at the fees paid in the " },
      { op: "delete", text: "6" },
      { op: "insert", text: "12" },
      { op: "equal", text: " months before the claim." },
    ],
    body: BODY,
    onBody: fn(),
    onRestore: fn(),
    onExport: fn(),
  },
} satisfies Meta<typeof DraftPane>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Editing: Story = {};
export const ShowEdits: Story = { args: { showEdits: true } };
export const OlderVersion: Story = { args: { versionNo: 1 } };
export const Exporting: Story = { args: { exporting: true } };
export const Notepad: Story = {
  args: {
    kind: "notepad",
    versions: [{ no: 1, createdAt: "2026-11-14T09:00:00Z", author: "assistant" }],
    versionNo: 1,
  },
};
export const Loading: Story = { render: () => <DraftPaneSkeleton /> };
