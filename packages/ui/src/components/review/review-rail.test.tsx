// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleReview } from "./fixtures.js";
import { type RailView, ReviewRail } from "./review-rail.js";

afterEach(cleanup);

type Props = Partial<ComponentProps<typeof ReviewRail>>;

function Harness(props: Props) {
  const [view, setView] = useState<RailView>("rules");
  const [why, setWhy] = useState(false);
  return (
    <ReviewRail
      review={sampleReview}
      kind="docx"
      view={view}
      onViewChange={setView}
      showJustifications={why}
      onShowJustifications={setWhy}
      {...props}
    />
  );
}

const headings = (level: number) =>
  screen.getAllByRole("heading", { level }).map((h) => h.textContent);

describe("ReviewRail", () => {
  it("lists rules in document order, missing and skipped last, then gaps", () => {
    render(<Harness />);
    expect(screen.getByText(/1 acceptable · 1 needs review · 1 not acceptable/)).toBeTruthy();
    expect(headings(3)).toEqual([
      "Confidentiality term",
      "Limitation of liability",
      "Payment terms",
      "Governing law",
      "Data protection",
      "Outside the playbook",
      "Clause outside the playbook",
    ]);
  });

  it("groups the suggestions view by status, then gaps", async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Suggestions" }));
    expect(headings(3)).toEqual([
      "Not acceptable",
      "Limitation of liability",
      "Needs review",
      "Confidentiality term",
      "Missing clauses",
      "Governing law",
      "Outside the playbook",
      "Clause outside the playbook",
    ]);
  });

  it("confirms Apply all with a count and passes the comment choice", async () => {
    const onApplyAll = vi.fn();
    const user = userEvent.setup();
    render(<Harness onApplyAll={onApplyAll} />);
    await user.click(screen.getByRole("button", { name: "Apply all (2)" }));
    const group = screen.getByRole("group", { name: "Apply all suggestions" });
    await user.click(within(group).getByLabelText(/as a comment/));
    await user.click(within(group).getByRole("button", { name: "Apply 2" }));
    expect(onApplyAll).toHaveBeenCalledWith(true);
  });

  it("downloads the redline and exports, but offers no redline for a PDF", async () => {
    const onDownloadRedline = vi.fn();
    const onExport = vi.fn();
    const user = userEvent.setup();
    render(<Harness onDownloadRedline={onDownloadRedline} onExport={onExport} />);
    await user.click(screen.getByLabelText(/Include undecided/));
    await user.click(screen.getByRole("button", { name: "Download redline" }));
    await user.click(screen.getByRole("button", { name: "Export summary (.xlsx)" }));
    expect(onDownloadRedline).toHaveBeenCalledWith(false);
    expect(onExport).toHaveBeenCalledWith("xlsx");
    cleanup();
    render(<Harness kind="pdf" onDownloadRedline={onDownloadRedline} onExport={onExport} />);
    expect(screen.getByText(/Redlines need the Word file/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download redline" })).toBeNull();
  });

  it("opens every justification with the toggle", async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByLabelText("Show justifications"));
    expect(screen.getAllByText("Justification.").length).toBeGreaterThan(0);
  });
});
