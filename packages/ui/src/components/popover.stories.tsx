import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";

const meta: Meta<typeof Popover> = {
  title: "Kit/Popover",
  component: Popover,
  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger asChild>
        <Button variant="secondary">Model</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Model details">
        <p className="font-medium">claude-haiku-5-5</p>
        <p className="text-fg-muted">Searched 2 documents. About 1,200 tokens.</p>
      </PopoverContent>
    </Popover>
  ),
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
