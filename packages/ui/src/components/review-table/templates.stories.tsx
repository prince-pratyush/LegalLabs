import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  SaveTemplateDialog,
  TemplateList,
  type TemplateSummary,
  TestTemplatePanel,
} from "./templates.js";

const base: TemplateSummary = {
  id: "t1",
  name: "Credit agreement terms",
  description: "Parties, commitments, governing law.",
  categories: ["Finance"],
  status: "draft",
  version: 1,
  columns: [
    { key: "c1", label: "Governing law" },
    { key: "c2", label: "Commitments" },
  ],
  my_access: "owner",
  rejected_note: null,
};

const noop = () => {};
const actions = {
  onUse: noop,
  onTest: noop,
  onShare: noop,
  onPublish: noop,
  onApprove: noop,
  onReject: noop,
  onDelete: noop,
};

const meta = {
  title: "Review tables/Templates",
  component: TemplateList,
  args: { templates: [base], ...actions },
} satisfies Meta<typeof TemplateList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Draft: Story = {};

export const Lifecycle: Story = {
  args: {
    templates: [
      { ...base, id: "a", status: "tested" },
      { ...base, id: "b", status: "pending_approval", my_access: "edit", name: "Lease terms" },
      { ...base, id: "c", status: "rejected", rejected_note: "Needs clearer prompts" },
      { ...base, id: "d", status: "published", version: 2, my_access: "use", name: "NDA terms" },
    ],
  },
};

export const Empty: Story = { args: { templates: [] } };

export const Loading: Story = { args: { loading: true } };

export const SaveDialog: Story = {
  render: () => (
    <SaveTemplateDialog
      open
      onOpenChange={noop}
      defaultName="Deal review"
      columnCount={12}
      onSave={async () => {}}
    />
  ),
};

export const TestPanel: Story = {
  render: () => (
    <TestTemplatePanel
      templateName="Credit agreement terms"
      vaults={[{ id: "v1", name: "Project Falcon" }]}
      loadTree={async () => ({ folders: [], files: [{ id: "f1", name: "Credit agreement.pdf" }] })}
      onTest={async () => {}}
      onClose={noop}
    />
  ),
};
