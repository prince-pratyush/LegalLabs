import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CustomiseReviewForm, CustomiseReviewFormSkeleton } from "./customise-review-form.js";
import { sampleRuleChoices } from "./fixtures.js";

const meta = {
  title: "Review/Customise",
  component: CustomiseReviewForm,
  args: {
    playbookId: "p1",
    documentId: "d1",
    rules: sampleRuleChoices,
    onSubmit: fn(),
    onCancel: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof CustomiseReviewForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FromAPlaybook: Story = {};
export const WithPickers: Story = {
  args: {
    playbooks: [
      { id: "p1", name: "Customer services agreement" },
      { id: "p2", name: "Customer NDA" },
    ],
    documents: [{ id: "d1", name: "Supplier services agreement.docx" }],
    onPlaybookChange: fn(),
    onDocumentChange: fn(),
  },
};
export const LongDocument: Story = { args: { pages: 140 } };
export const Editor: Story = { args: { canUseDraft: true } };
export const Starting: Story = { args: { busy: true } };
export const Failed: Story = {
  args: { error: "That document is over 1,000,000 characters." },
};
export const Loading: Story = { render: () => <CustomiseReviewFormSkeleton /> };
