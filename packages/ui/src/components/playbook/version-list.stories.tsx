import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { sampleVersions } from "./fixtures.js";
import { VersionList, VersionListSkeleton } from "./version-list.js";

const meta = {
  title: "Playbook/Version list",
  component: VersionList,
  args: { versions: sampleVersions, current: 3, onView: fn() },
  decorators: [(Story) => <div className="w-[260px]">{Story()}</div>],
} satisfies Meta<typeof VersionList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {};
export const ViewingAnOlderVersion: Story = { args: { viewing: 1 } };
export const WithAuthors: Story = { args: { authorName: () => "Jane Doe" } };
export const Loading: Story = { render: () => <VersionListSkeleton /> };
