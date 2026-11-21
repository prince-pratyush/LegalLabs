import type { Meta, StoryObj } from "@storybook/react-vite";
import { AddColumnForm, AddColumnPopover } from "./add-column.js";

const meta = {
  title: "Review tables/Add column",
  component: AddColumnForm,
  args: { onAdd: () => {} },
  decorators: [(Story) => <div className="w-96">{<Story />}</div>],
} satisfies Meta<typeof AddColumnForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const WithServerError: Story = {
  args: { error: "This table already has 500 columns." },
};

export const Loading: Story = { args: { busy: true } };

/** Type @ in the prompt to use another column's answer. */
export const WithColumnsToMention: Story = {
  args: {
    columns: [
      { id: "0194f3a0-0000-7000-8000-00000000000a", label: "Governing law" },
      { id: "0194f3a0-0000-7000-8000-00000000000b", label: "Term" },
    ],
  },
};

export const InPopover: Story = {
  render: () => <AddColumnPopover open onOpenChange={() => {}} onAdd={() => {}} />,
};
