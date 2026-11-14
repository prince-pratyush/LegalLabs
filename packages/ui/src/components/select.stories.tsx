import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";

const meta: Meta<typeof Select> = {
  title: "Kit/Select",
  component: Select,
  render: (args) => (
    <div className="grid max-w-xs gap-1">
      <Label id="scope-label">Scope</Label>
      <Select {...args}>
        <SelectTrigger aria-labelledby="scope-label">
          <SelectValue placeholder="Choose a scope" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="chosen">Chosen documents</SelectItem>
          <SelectItem value="vault">Whole vault</SelectItem>
          <SelectItem value="web" disabled>
            The web (off for this workspace)
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Chosen: Story = { args: { defaultValue: "vault" } };
export const Open: Story = { args: { defaultValue: "chosen", defaultOpen: true } };
export const Disabled: Story = { args: { disabled: true, defaultValue: "chosen" } };
