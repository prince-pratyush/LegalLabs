import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ShareForm, ShareFormSkeleton } from "./share-form.js";

const meta = {
  title: "Thread/Share form",
  component: ShareForm,
  args: {
    members: [
      { id: "u1", name: "Jane Doe", email: "jane@example.test" },
      { id: "u2", name: "Sam Lee", email: "sam@example.test" },
    ],
    shares: [
      { id: "s1", label: "Sam Lee", kind: "user" },
      { id: "s2", label: "Anyone in the workspace", kind: "link" },
    ],
    onShare: fn(),
    onRevoke: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof ShareForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NotSharedYet: Story = { args: { shares: [] } };
export const SomeRejected: Story = {
  args: {
    rejected: [
      { name: "Alex Kim", reason: "WALL_DENIED" },
      { name: "pat@other.test", reason: "NOT_MEMBER" },
    ],
  },
};
export const Walled: Story = { args: { walled: true } };
export const Loading: Story = { render: () => <ShareFormSkeleton /> };
