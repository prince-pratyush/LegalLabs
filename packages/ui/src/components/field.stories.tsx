import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, Input, Textarea } from "./field.js";

const meta = {
  title: "Kit/Field",
  component: Field,
  args: { label: "Workspace", children: (props) => <Input {...props} /> },
  decorators: [(Story) => <div className="max-w-sm">{Story()}</div>],
} satisfies Meta<typeof Field>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextInput: Story = {};
export const WithHint: Story = {
  args: { hint: "The short name your admin gave you, like acme." },
};
export const WithError: Story = {
  args: {
    label: "Email",
    error: "Enter an email address, like ana@acme.test.",
    children: (props) => <Input type="email" defaultValue="ana@" {...props} />,
  },
};
export const Disabled: Story = {
  args: { children: (props) => <Input disabled defaultValue="acme" {...props} /> },
};
export const Placeholder: Story = {
  args: { children: (props) => <Input placeholder="acme" {...props} /> },
};
export const MultiLine: Story = {
  args: {
    label: "Question",
    hint: "Up to 2,000 characters.",
    children: (props) => <Textarea rows={3} {...props} />,
  },
};
