import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText } from "lucide-react";
import { fn } from "storybook/test";
import { LibraryList, LibraryListSkeleton } from "./library-list.js";

const meta = {
  title: "Library/List",
  component: LibraryList,
  args: {
    label: "Saved prompts",
    entries: [
      {
        id: "p1",
        name: "NDA first pass",
        description: "Flags one-sided confidentiality terms for {{counterparty}}.",
        meta: "Ana Silva · updated 2 Nov",
        badges: ["2 variables", "Shared"],
        actions: [
          { label: "Use", onClick: fn(), primary: true },
          { label: "Share", onClick: fn() },
          { label: "Edit", onClick: fn() },
        ],
      },
      {
        id: "p2",
        name: "Summarise a lease",
        meta: "Ben Ito · updated 28 Oct",
        actions: [{ label: "Use", onClick: fn(), primary: true }],
      },
    ],
    empty: {
      icon: FileText,
      title: "No saved prompts yet",
      description: "Save a prompt you use often, with {{variables}} for the parts that change.",
      action: { label: "New prompt", onClick: fn() },
    },
  },
} satisfies Meta<typeof LibraryList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Prompts: Story = {};
export const Templates: Story = {
  args: {
    label: "Firm templates",
    entries: [
      {
        id: "t1",
        name: "Letterhead",
        description: "Georgia, lettered clauses, confidential header.",
        meta: "Version 3 · firm.docx · 42 KB",
        badges: ["Default"],
        actions: [
          { label: "Preview PDF", onClick: fn() },
          { label: "New version", onClick: fn() },
        ],
      },
    ],
  },
};
export const Empty: Story = { args: { entries: [] } };
export const Loading: Story = { render: () => <LibraryListSkeleton /> };
