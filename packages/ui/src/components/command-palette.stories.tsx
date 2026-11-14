import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CommandPalette, type PaletteCommand } from "./command-palette.js";

export const SAMPLE_COMMANDS: PaletteCommand[] = [
  { id: "t1", kind: "object", group: "Threads", label: "What is the liability cap?", run: fn() },
  { id: "t2", kind: "object", group: "Threads", label: "Termination for convenience", run: fn() },
  {
    id: "d1",
    kind: "object",
    group: "Documents",
    label: "Master services agreement.pdf",
    run: fn(),
  },
  {
    id: "d2",
    kind: "object",
    group: "Documents",
    label: "Vendor NDA.pdf",
    keywords: ["confidentiality"],
    run: fn(),
  },
  {
    id: "a1",
    kind: "action",
    group: "Actions",
    label: "New thread",
    shortcut: "mod+shift+o",
    run: fn(),
  },
  { id: "a2", kind: "action", group: "Actions", label: "Upload a document", run: fn() },
  { id: "a3", kind: "action", group: "Settings", label: "Switch to dark theme", run: fn() },
  { id: "a4", kind: "action", group: "Settings", label: "Use compact density", run: fn() },
];

const meta = {
  title: "Shell/Command palette",
  component: CommandPalette,
  args: { open: true, onOpenChange: fn(), commands: SAMPLE_COMMANDS },
} satisfies Meta<typeof CommandPalette>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Objects: Story = {};
export const Filtered: Story = { args: { initialSearch: "nda" } };
export const Actions: Story = { args: { initialSearch: ">" } };
export const Shortcuts: Story = { args: { initialSearch: "?" } };
export const NoMatch: Story = { args: { initialSearch: "zzzz" } };
