import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy, Download, Pencil, Trash2 } from "lucide-react";
import { Button } from "./button.js";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./menu.js";

const meta: Meta<typeof Menu> = {
  title: "Kit/Dropdown menu",
  component: Menu,
  render: (args) => (
    <Menu {...args}>
      <MenuTrigger asChild>
        <Button variant="secondary">Thread actions</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>What is the cap?</MenuLabel>
        <MenuItem>
          <Pencil aria-hidden /> Rename
        </MenuItem>
        <MenuItem shortcut="⌘E">
          <Download aria-hidden /> Export
        </MenuItem>
        <MenuItem disabled>
          <Copy aria-hidden /> Duplicate
        </MenuItem>
        <MenuSeparator />
        <MenuItem destructive>
          <Trash2 aria-hidden /> Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  ),
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
