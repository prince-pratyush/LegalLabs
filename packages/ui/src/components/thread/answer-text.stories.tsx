import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { AnswerCitation } from "./answer.js";
import { AnswerText, AnswerTextSkeleton } from "./answer-text.js";

const TEXT =
  "The cap is the fees paid in the twelve months before the claim. It does not apply to fraud. The parties also agreed to mediate first.";

const CITATIONS: AnswerCitation[] = [
  {
    n: 1,
    at: 63,
    status: "ok",
    documentName: "Master services agreement.pdf",
    page: 14,
    quote: "shall not exceed the fees paid in the twelve months before the claim",
  },
  {
    n: 2,
    at: 91,
    status: "mismatch",
    documentName: "Master services agreement.pdf",
    page: 15,
    quote: "This cap does not apply to fraud",
  },
];

const meta = {
  title: "Thread/Answer text",
  component: AnswerText,
  args: { text: TEXT, citations: CITATIONS, onOpen: fn() },
} satisfies Meta<typeof AnswerText>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Verified: Story = {};
export const WithUngroundedSentence: Story = { args: { ungrounded: [[92, 133]] } };
export const Streaming: Story = {
  args: {
    text: "The cap is the fees paid in the twelve months before the claim.[[c:1]] It does not apply[[c:2]]",
    citations: CITATIONS.slice(0, 1).map((c) => ({ ...c, at: 0 })),
    streaming: true,
  },
};
export const NotFound: Story = {
  args: { text: "I couldn't find this in the selected documents.", citations: [] },
};
export const Loading: Story = { render: () => <AnswerTextSkeleton /> };
