import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { fn } from "storybook/test";
import { AgentEditor, AgentEditorSkeleton } from "./agent-editor.js";
import type { AgentContent } from "./types.js";

const content: AgentContent = {
  instructions:
    "Review the NDA against @Playbook.\n\nFlag anything outside our positions and draft a short summary email. Compare with @Precedents if useful.",
  attachments: [{ label: "Playbook", kind: "playbook", ref: "p1", name: "NDA playbook" }],
  sources: [{ label: "Case law", kind: "knowledge_source", source: "s1", name: "Case law (AU)" }],
};

function Stateful(props: ComponentProps<typeof AgentEditor>) {
  const [value, setValue] = useState(props.value);
  return <AgentEditor {...props} value={value} onChange={setValue} />;
}

const meta = {
  title: "Agents/Editor",
  component: AgentEditor,
  args: {
    value: content,
    onChange: fn(),
    attachChoices: [
      { kind: "vault", ref: "v1", name: "Precedents vault" },
      { kind: "upload", ref: "d1", name: "Template NDA.docx" },
    ],
    sourceChoices: [{ kind: "knowledge_source", source: "s2", name: "Legislation" }],
    onSave: fn(),
    hasLive: true,
  },
  render: (args) => <Stateful {...args} />,
  decorators: [(Story) => <div className="max-w-2xl">{Story()}</div>],
} satisfies Meta<typeof AgentEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithUnresolvedName: Story = {};
export const FirstSave: Story = {
  args: { value: { instructions: "", attachments: [], sources: [] }, hasLive: false },
};
export const Refused: Story = { args: { error: "1 attachment unavailable to you." } };
export const ReadOnly: Story = { args: { readOnly: true } };
export const Loading: Story = { render: () => <AgentEditorSkeleton /> };
