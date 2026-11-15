import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { LibraryShareForm, LibraryShareFormSkeleton } from "./library-share.js";

const meta = {
  title: "Library/Share form",
  component: LibraryShareForm,
  args: {
    shares: [
      { principalType: "group", principalId: "g1", label: "Commercial team", level: "use" },
      { principalType: "user", principalId: "u2", label: "Sam Lee", level: "edit" },
    ],
    workspace: { principalType: "workspace", principalId: "w1", label: "Everyone" },
    canShareWorkspace: false,
    search: async () => [
      { principalType: "user", principalId: "u3", label: "Alex Kim" },
      { principalType: "group", principalId: "g2", label: "Disputes" },
    ],
    onChange: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof LibraryShareForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SharedWithTwo: Story = {};
export const NotShared: Story = { args: { shares: [] } };
export const Manager: Story = { args: { canShareWorkspace: true } };
export const Refused: Story = {
  args: { error: "Only Library managers can share with everyone in the workspace." },
};
export const Loading: Story = { render: () => <LibraryShareFormSkeleton /> };
