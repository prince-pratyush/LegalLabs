import type { Meta, StoryObj } from "@storybook/react-vite";
import { CreateTablePanel, type VaultTree } from "./create-table.js";

const TREE: VaultTree = {
  folders: [
    { id: "f1", name: "Leases" },
    { id: "f2", name: "Financing" },
  ],
  files: [{ id: "d1", name: "Disclosure letter.pdf" }],
};

const meta = {
  title: "Review tables/Create table",
  component: CreateTablePanel,
  args: {
    vaults: [
      { id: "v1", name: "Falcon DD" },
      { id: "v2", name: "Atlas" },
    ],
    threads: [{ id: "t1", title: "Termination rights in the Falcon leases" }],
    loadTree: async () => TREE,
    onCreate: async () => {},
    onClose: () => {},
  },
  decorators: [(Story) => <div className="flex h-[36rem] justify-end">{<Story />}</div>],
} satisfies Meta<typeof CreateTablePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FromVault: Story = {};

export const FromThread: Story = { args: { initialThreadId: "t1" } };

// The create call never returns, so the button stays busy.
export const Loading: Story = {
  args: { initialThreadId: "t1", onCreate: () => new Promise(() => {}) },
  play: async () => {
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Create table")?.click();
  },
};
