import { diffWords } from "@legallabs/contracts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AgentChanges, AgentChangesSkeleton, AgentVersionList } from "./agent-changes.js";

const ops = diffWords(
  "Review the NDA against @Playbook and flag deviations.",
  "Review the NDA against @Playbook, flag deviations and draft a summary email.",
);

const meta = {
  title: "Agents/Changes",
  component: AgentChanges,
  args: {
    ops,
    fromLabel: "Live (version 3)",
    toLabel: "Draft (version 4)",
    attachments: {
      added: [{ kind: "vault", label: "Precedents", name: "Precedents vault" }],
      removed: [{ kind: "upload", label: "Old template", name: "template-2023.docx" }],
    },
    sources: { added: [], removed: [] },
    onAccept: fn(),
    onDiscard: fn(),
  },
  decorators: [(Story) => <div className="max-w-3xl">{Story()}</div>],
} satisfies Meta<typeof AgentChanges>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Redline: Story = {};
export const ReadOnly: Story = {
  render: ({ onAccept: _a, onDiscard: _d, ...args }) => <AgentChanges {...args} />,
};
export const NoChanges: Story = {
  args: {
    ops: [{ op: "equal", text: "Same." }],
    attachments: { added: [], removed: [] },
  },
};
export const Versions: Story = {
  render: () => (
    <AgentVersionList
      versions={[
        { id: "v4", no: 4, createdAt: "2026-11-20T09:00:00Z", live: false, draft: true },
        { id: "v3", no: 3, createdAt: "2026-11-18T09:00:00Z", live: true, draft: false },
        { id: "v1", no: 1, createdAt: "2026-11-01T09:00:00Z", live: false, draft: false },
      ]}
      onCompare={fn()}
    />
  ),
};
export const Loading: Story = { render: () => <AgentChangesSkeleton /> };
