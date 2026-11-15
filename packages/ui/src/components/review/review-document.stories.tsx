import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { sampleFindings, sampleGaps, sampleParagraphs } from "./fixtures.js";
import { gapItem, ruleItem } from "./order.js";
import { ReviewDocument, ReviewDocumentSkeleton } from "./review-document.js";

const items = [...sampleFindings.map(ruleItem), ...sampleGaps.map(gapItem)];

const meta = {
  title: "Review/Document",
  component: ReviewDocument,
  args: { paragraphs: sampleParagraphs, items, onSelect: fn() },
} satisfies Meta<typeof ReviewDocument>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Highlighted: Story = {};
export const Selected: Story = { args: { selectedId: items[0]?.id ?? null } };
export const WithJustifications: Story = { args: { showJustifications: true } };
export const ReadOnly: Story = {
  render: (args) => <ReviewDocument paragraphs={args.paragraphs} items={args.items} />,
};
export const Loading: Story = { render: () => <ReviewDocumentSkeleton /> };
