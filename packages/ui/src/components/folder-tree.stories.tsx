import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { FolderTree, type TreeFolder } from "./folder-tree.js";

const FOLDERS: TreeFolder[] = [
  { id: "contracts", name: "Contracts", parentId: null },
  { id: "corporate", name: "Corporate records", parentId: null },
  { id: "ip", name: "Intellectual property", parentId: null },
  { id: "msa", name: "Master services agreements", parentId: "contracts" },
  { id: "nda", name: "Non-disclosure agreements", parentId: "contracts" },
  { id: "2024", name: "2024", parentId: "msa" },
];

const meta = {
  title: "Kit/Folder tree",
  component: FolderTree,
  args: {
    label: "Folders",
    rootLabel: "Project Atlas data room",
    folders: FOLDERS,
    expanded: new Set(["contracts"]),
    selectedId: "nda",
    onSelect: fn(),
    onToggle: fn(),
  },
  decorators: [(Story) => <div className="w-64">{Story()}</div>],
} satisfies Meta<typeof FolderTree>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};
export const TopLevelSelected: Story = { args: { expanded: new Set(), selectedId: null } };
export const Loading: Story = { args: { folders: [], expanded: new Set(), loading: [null] } };
export const LoadingChildren: Story = {
  args: { expanded: new Set(["contracts", "corporate"]), loading: ["corporate"] },
};
export const Interactive: Story = {
  render: (args) => {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <FolderTree
        {...args}
        expanded={expanded}
        selectedId={selected}
        onSelect={setSelected}
        onToggle={(id) => {
          const next = new Set(expanded);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          setExpanded(next);
        }}
      />
    );
  },
};
