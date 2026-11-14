import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { AnswerCitation } from "./answer.js";
import { SourcesList, SourcesListSkeleton } from "./sources-list.js";

const cite = (n: number, page: number | null, extra: Partial<AnswerCitation> = {}) => ({
  n,
  at: 0,
  status: "ok" as const,
  documentName: "Master services agreement.pdf",
  page,
  quote: "The Supplier's aggregate liability shall not exceed the fees paid in the 12 months.",
  ...extra,
});

const meta = {
  title: "Thread/Sources list",
  component: SourcesList,
  args: {
    citations: [
      cite(2, 15),
      cite(1, 14),
      cite(3, 2, { documentName: "Side letter.docx", status: "mismatch" }),
      cite(4, null, { documentName: null, status: "unresolved", quote: null }),
    ],
    onOpen: fn(),
    activeN: 1,
  },
} satisfies Meta<typeof SourcesList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {};
export const Empty: Story = { args: { citations: [] } };
export const Loading: Story = { render: () => <SourcesListSkeleton /> };
