// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liabilitySuggestion, sampleFindings, sampleGaps, sampleParagraphs } from "./fixtures.js";
import { gapItem, ruleItem } from "./order.js";
import { marksByParagraph, ReviewDocument } from "./review-document.js";

afterEach(cleanup);

const items = [...sampleFindings.map(ruleItem), ...sampleGaps.map(gapItem)];

describe("marksByParagraph", () => {
  it("lets an edit win over the evidence it overlaps", () => {
    const marks = marksByParagraph(items);
    // Liability: the edit and the evidence cover the same words.
    expect(marks.get(3)?.map((m) => Boolean(m.suggestion))).toEqual([true]);
    // Assignment: the quote and a pending edit inside it overlap; the edit is kept.
    expect(marks.get(5)?.map((m) => m.suggestion?.before ?? "evidence")).toEqual([
      "without notice",
    ]);
    // Payment: evidence only.
    expect(marks.get(4)?.map((m) => Boolean(m.suggestion))).toEqual([false]);
  });
});

describe("ReviewDocument", () => {
  it("shows applied edits as tracked changes and leaves dismissed ones out", () => {
    render(<ReviewDocument paragraphs={sampleParagraphs} items={items} />);
    expect(screen.getByText("one year", { selector: "del" })).toBeTruthy();
    expect(screen.getByText("three years", { selector: "ins" })).toBeTruthy();
    // The governing-law insertion was dismissed.
    expect(screen.queryByText(/governed by the laws/)).toBeNull();
    expect(screen.getByText(/not reviewed for edits/)).toBeTruthy();
  });

  it("selects a card from its highlight and shows justifications on request", async () => {
    const onSelect = vi.fn();
    render(
      <ReviewDocument
        paragraphs={sampleParagraphs}
        items={items}
        onSelect={onSelect}
        showJustifications
      />,
    );
    await userEvent.setup().click(screen.getByText(liabilitySuggestion.before));
    expect(onSelect).toHaveBeenCalledWith(`rule:${liabilitySuggestion.rule_id}`);
    expect(
      screen.getByRole("complementary", { name: "Justification: Limitation of liability" }),
    ).toBeTruthy();
  });

  it("scrolls to the focused paragraph", () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    render(<ReviewDocument paragraphs={sampleParagraphs} items={items} focus={{ paragraph: 4 }} />);
    expect(scroll).toHaveBeenCalledOnce();
    expect((scroll.mock.contexts[0] as HTMLElement).dataset.paragraph).toBe("4");
  });
});
