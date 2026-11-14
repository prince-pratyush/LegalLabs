import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CitationMarker, type Evidence } from "./evidence.js";

const VERIFIED: Evidence = {
  n: 1,
  status: "ok",
  documentName: "Master services agreement.pdf",
  page: 14,
  quote:
    "The Supplier's aggregate liability shall not exceed the fees paid in the 12 months before the claim.",
};

const meta = {
  title: "Domain/Citation marker",
  component: CitationMarker,
  args: { evidence: VERIFIED, onOpen: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof CitationMarker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Verified: Story = {};
export const VerifiedOpen: Story = { args: { defaultOpen: true } };
export const NotFoundOnPage: Story = {
  args: { defaultOpen: true, evidence: { ...VERIFIED, n: 2, status: "mismatch" } },
};
export const Unresolved: Story = {
  args: {
    defaultOpen: true,
    evidence: { n: 3, status: "unresolved", documentName: null, page: null, quote: null },
  },
};
export const LongQuoteIsClipped: Story = {
  args: { defaultOpen: true, evidence: { ...VERIFIED, quote: VERIFIED.quote?.repeat(6) ?? null } },
};
export const InProse: Story = {
  render: (args) => (
    <p className="max-w-[72ch] text-prose">
      The cap is twelve months of fees
      <CitationMarker {...args} />, and it excludes fraud
      <CitationMarker {...args} evidence={{ ...VERIFIED, n: 2, status: "mismatch" }} />.
    </p>
  ),
};
