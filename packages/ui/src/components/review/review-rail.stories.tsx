import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { sampleReview } from "./fixtures.js";
import { type RailView, ReviewRail, ReviewRailSkeleton } from "./review-rail.js";

const meta = {
  title: "Review/Rail",
  component: ReviewRail,
  args: {
    review: sampleReview,
    kind: "docx",
    view: "rules",
    onViewChange: fn(),
    showJustifications: false,
    onShowJustifications: fn(),
    onApplyAll: fn(),
    onDownloadRedline: fn(),
    onExport: fn(),
    onApply: fn(),
    onDismiss: fn(),
    onRevise: fn(),
    onAlternates: fn(),
    onGoTo: fn(),
  },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof ReviewRail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Rules: Story = {};
export const Suggestions: Story = { args: { view: "suggestions" } };
export const Interactive: Story = {
  render: (args) => {
    const [view, setView] = useState<RailView>("rules");
    const [why, setWhy] = useState(false);
    return (
      <ReviewRail
        {...args}
        view={view}
        onViewChange={setView}
        showJustifications={why}
        onShowJustifications={setWhy}
      />
    );
  },
};
export const Pdf: Story = {
  args: { kind: "pdf", review: { ...sampleReview, warnings: ["pdf_no_redlines"] } },
};
export const StillRunning: Story = {
  args: { review: { ...sampleReview, status: "running", warnings: ["over_100_pages"] } },
};
export const Downloading: Story = { args: { downloading: "redline" } };
export const Loading: Story = { render: () => <ReviewRailSkeleton /> };
