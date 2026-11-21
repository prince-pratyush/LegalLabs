import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ImportPreview, type ImportPreviewData } from "./import-preview.js";

const preview: ImportPreviewData = {
  title: "NDA first pass",
  description: "Reviews inbound NDAs against the playbook.",
  instructions: "# NDA first pass\n\nCompare the NDA with @Playbook and list deviations.",
  files: [
    { label: "Playbook", name: "playbook.pdf", size: 240_000, status: "ok" },
    { label: "Video", name: "walkthrough.mov", size: 90_000_000, status: "too_large" },
  ],
  refs: [{ label: "Precedents", kind: "vault", name: "Precedents", resolved: false }],
  sources: [
    { label: "Case law", source: "case-law-au", status: "ok" },
    { label: "Old index", source: "other-deployment-42", status: "unknown_source" },
  ],
  issues: [{ kind: "file", label: "Video", status: "too_large", detail: "Over the 50 MB limit." }],
};

const meta = {
  title: "Agents/Import preview",
  component: ImportPreview,
  args: { preview, onConfirm: fn(), onCancel: fn() },
  decorators: [(Story) => <div className="max-w-lg">{Story()}</div>],
} satisfies Meta<typeof ImportPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithIssues: Story = {};
export const Clean: Story = {
  args: {
    preview: { ...preview, files: [], refs: [], sources: [], issues: [] },
  },
};
export const Expired: Story = { args: { error: "That import expired. Upload the file again." } };
