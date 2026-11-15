import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Breadcrumbs } from "./breadcrumbs.js";
import { Skeleton } from "./status.js";

const meta = {
  title: "Kit/Breadcrumbs",
  component: Breadcrumbs,
  args: {
    items: [
      { id: null, label: "Project Atlas data room" },
      { id: "contracts", label: "Contracts" },
      { id: "msa", label: "Master services agreements" },
    ],
    onSelect: fn(),
  },
} satisfies Meta<typeof Breadcrumbs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Nested: Story = {};
export const TopLevel: Story = {
  args: { items: [{ id: null, label: "Project Atlas data room" }] },
};
export const Loading: Story = {
  render: () => (
    <div aria-busy="true">
      <Skeleton className="h-5 w-72" />
    </div>
  ),
};
