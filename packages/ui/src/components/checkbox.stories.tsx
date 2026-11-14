import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox.js";

const meta: Meta<typeof Checkbox> = {
  title: "Kit/Checkbox",
  component: Checkbox,
  render: (args) => (
    <div className="inline-flex items-center gap-1 text-ui">
      <Checkbox id="msa" {...args} />
      <label htmlFor="msa">msa.pdf</label>
    </div>
  ),
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const Indeterminate: Story = { args: { checked: "indeterminate" } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledChecked: Story = { args: { disabled: true, defaultChecked: true } };
