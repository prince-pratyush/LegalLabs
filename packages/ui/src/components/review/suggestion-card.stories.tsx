import type { Finding, Gap as GapShape } from "@legallabs/contracts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { sampleFindings, sampleGaps } from "./fixtures.js";
import { gapItem, ruleItem } from "./order.js";
import { SuggestionCard, SuggestionCardSkeleton } from "./suggestion-card.js";

const [liability, confidentiality, payment, missing] = sampleFindings as Finding[];
const rule = (f: Finding | undefined) => ruleItem(f as Finding);

const meta = {
  title: "Review/Suggestion card",
  component: SuggestionCard,
  args: {
    item: rule(liability),
    onGoTo: fn(),
    onApply: fn(),
    onDismiss: fn(),
    onRevise: fn(),
    onAlternates: fn(),
    onSelect: fn(),
  },
  decorators: [(Story) => <div className="w-[400px]">{Story()}</div>],
} satisfies Meta<typeof SuggestionCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotAcceptable: Story = {};
export const Selected: Story = { args: { selected: true, showJustification: true } };
export const Applied: Story = { args: { item: rule(confidentiality) } };
export const Acceptable: Story = { args: { item: rule(payment) } };
export const MissingClause: Story = { args: { item: rule(missing) } };
export const Gap: Story = { args: { item: gapItem(sampleGaps[0] as GapShape) } };
export const AnchorFailed: Story = {
  args: {
    item: rule(
      liability?.suggestion
        ? { ...liability, suggestion: { ...liability.suggestion, status: "anchor_failed" } }
        : liability,
    ),
    onRerun: fn(),
  },
};
export const LoadingAlternates: Story = { args: { alternates: null } };
export const WithAlternates: Story = {
  args: {
    alternates: [
      {
        id: "0190b000-0000-7000-8000-000000000a01",
        after: "capped at the fees paid in the 18 months before the claim",
        justification: "The playbook's first fallback.",
      },
    ],
  },
};
export const Saving: Story = { args: { busy: true } };
export const Loading: Story = { render: () => <SuggestionCardSkeleton /> };
