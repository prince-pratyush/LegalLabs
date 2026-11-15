import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CreatePlaybookForm, CreatePlaybookFormSkeleton } from "./create-playbook-form.js";

const meta = {
  title: "Playbook/Create form",
  component: CreatePlaybookForm,
  args: {
    playbooks: [
      { id: "p1", name: "Customer NDA" },
      { id: "p2", name: "SaaS MSA" },
    ],
    documents: [{ id: "d1", name: "Signed supplier MSA.pdf" }],
    onSubmit: fn(),
    onCancel: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof CreatePlaybookForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NothingToCopy: Story = { args: { playbooks: [], documents: [] } };
export const Creating: Story = { args: { busy: true } };
export const Failed: Story = {
  args: { error: "No positions could be found in that document. Try another." },
};
export const Loading: Story = { render: () => <CreatePlaybookFormSkeleton /> };
