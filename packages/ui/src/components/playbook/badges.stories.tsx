import type { Meta, StoryObj } from "@storybook/react-vite";
import { BadgeSkeleton, PlaybookStatus, ProvenanceBadge } from "./badges.js";

const meta = {
  title: "Playbook/Badges",
  component: PlaybookStatus,
  args: { status: "published" },
} satisfies Meta<typeof PlaybookStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Published: Story = {};
export const Unpublished: Story = { args: { status: "unpublished" } };
export const SourceVerified: Story = {
  render: () => (
    <ProvenanceBadge
      provenance={{
        quote: "total liability is capped at the fees paid in the twelve months",
        verified: true,
      }}
    />
  ),
};
export const CheckSource: Story = { render: () => <ProvenanceBadge provenance={null} /> };
export const Loading: Story = { render: () => <BadgeSkeleton /> };
