import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { Composer, type ComposerProps, ComposerSkeleton } from "./composer.js";

const BASE: ComposerProps = {
  value: "",
  onChange: fn(),
  onSend: fn(),
  onStop: fn(),
  streaming: false,
  workIn: { label: "Acme / Falcon" },
  onWorkIn: fn(),
  attachments: [
    { id: "d1", label: "MSA_v3.docx", kind: "file" },
    { id: "d2", label: "Side letter.pdf", kind: "file", status: "processing" },
    { id: "v1", label: "Falcon DD (1,204 files)", kind: "vault" },
  ],
  onRemove: fn(),
  onAttachFiles: fn(),
  vaults: [
    { id: "v1", name: "Falcon DD", fileCount: 1204 },
    { id: "v2", name: "Templates", fileCount: 38 },
    { id: "v3", name: "Board papers", fileCount: 410 },
  ],
  selectedVaultIds: ["v1"],
  onToggleVault: fn(),
  sources: [
    { id: "us-case-law", name: "US case law", jurisdiction: "US" },
    { id: "edgar", name: "EDGAR filings", jurisdiction: "US" },
    { id: "eur-lex", name: "EUR-Lex", jurisdiction: "EU" },
  ],
  selectedSourceIds: [],
  onToggleSource: fn(),
  models: [
    { id: "auto", label: "Auto" },
    { id: "ollama/qwen3:4b-instruct", label: "Qwen3 4B", hint: "local" },
  ],
  model: "auto",
  onModel: fn(),
  deepAnalysis: false,
  onDeepAnalysis: fn(),
  mentionables: [
    { type: "document", id: "d1", label: "MSA_v3.docx" },
    { type: "vault", id: "v1", label: "Falcon DD" },
    { type: "source", id: "edgar", label: "EDGAR filings" },
  ],
  onMention: fn(),
};

const meta = {
  title: "Thread/Composer",
  component: Composer,
  args: BASE,
} satisfies Meta<typeof Composer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { attachments: [], workIn: null } };
export const WithScope: Story = { args: { value: "What is the liability cap?" } };
export const Streaming: Story = { args: { value: "", streaming: true } };
export const OverLimit: Story = {
  args: { value: "Summarise", disabledReason: "Remove a vault: a thread can read 2 at most." },
};
export const DeepAnalysisOn: Story = { args: { deepAnalysis: true, value: "Find every consent" } };
export const Interactive: Story = {
  render: (args) => {
    const [value, setValue] = useState("Compare @");
    return <Composer {...args} value={value} onChange={setValue} />;
  },
};
export const Loading: Story = { render: () => <ComposerSkeleton /> };
