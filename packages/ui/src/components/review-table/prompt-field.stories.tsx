import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { PromptField } from "./prompt-field.js";

const COLUMNS = [
  { id: "0194f3a0-0000-7000-8000-00000000000a", label: "Governing law" },
  { id: "0194f3a0-0000-7000-8000-00000000000b", label: "Term" },
  { id: "0194f3a0-0000-7000-8000-00000000000c", label: "Termination fee" },
];

const meta = {
  title: "Review tables/Prompt field",
  component: PromptField,
  args: { value: "", onChange: () => {}, columns: COLUMNS, "aria-label": "Prompt" },
  decorators: [(Story) => <div className="w-96">{<Story />}</div>],
} satisfies Meta<typeof PromptField>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Type @ to list the table's other columns; Enter or a click inserts the one chosen. */
export const Empty: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    return <PromptField {...args} value={value} onChange={setValue} />;
  },
};

export const WithMentions: Story = {
  args: { value: "Is @{Governing law} the same as in @{Term}?" },
};
