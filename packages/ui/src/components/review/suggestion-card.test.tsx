// @vitest-environment jsdom
import type { Finding } from "@legallabs/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liabilitySuggestion, sampleFindings, sampleGaps } from "./fixtures.js";
import { gapItem, ruleItem } from "./order.js";
import { SuggestionCard } from "./suggestion-card.js";

afterEach(cleanup);

const liability = sampleFindings[0] as Finding;
const button = (name: string) => screen.getByRole("button", { name });

describe("SuggestionCard", () => {
  it("shows the finding, its evidence and the edit, and goes to the clause", async () => {
    const onGoTo = vi.fn();
    render(<SuggestionCard item={ruleItem(liability)} onGoTo={onGoTo} />);
    expect(screen.getByText("Not acceptable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Limitation of liability" })).toBeTruthy();
    expect(screen.getByText("§3")).toBeTruthy();
    expect(screen.getByText(liabilitySuggestion.after)).toBeTruthy();
    await userEvent.setup().click(button("Go to §3"));
    expect(onGoTo).toHaveBeenCalledWith(3);
  });

  it("applies, applies with comment and dismisses", async () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<SuggestionCard item={ruleItem(liability)} onApply={onApply} onDismiss={onDismiss} />);
    await user.click(button("Apply"));
    await user.click(button("Apply with comment"));
    await user.click(button("Dismiss"));
    expect(onApply.mock.calls).toEqual([
      [liabilitySuggestion, { withComment: false }],
      [liabilitySuggestion, { withComment: true }],
    ]);
    expect(onDismiss).toHaveBeenCalledWith(liabilitySuggestion);
  });

  it("sends a revision instruction", async () => {
    const onRevise = vi.fn();
    const user = userEvent.setup();
    render(<SuggestionCard item={ruleItem(liability)} onRevise={onRevise} />);
    await user.click(button("Revise"));
    await user.type(screen.getByLabelText("How should it change?"), "use 18 months");
    await user.click(screen.getAllByRole("button", { name: "Revise" })[1] as HTMLElement);
    expect(onRevise).toHaveBeenCalledWith(liabilitySuggestion, "use 18 months");
  });

  it("asks for alternates once and applies one", async () => {
    const onAlternates = vi.fn();
    const onApply = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SuggestionCard item={ruleItem(liability)} onAlternates={onAlternates} onApply={onApply} />,
    );
    await user.click(button("Alternates"));
    expect(onAlternates).toHaveBeenCalledWith(liabilitySuggestion);
    const alt = {
      id: "0190b000-0000-7000-8000-000000000a01",
      after: "18 months",
      justification: "",
    };
    rerender(
      <SuggestionCard
        item={ruleItem(liability)}
        alternates={[alt]}
        onAlternates={onAlternates}
        onApply={onApply}
      />,
    );
    expect((button("Alternates") as HTMLButtonElement).disabled).toBe(true);
    await user.click(button("Apply alternate 1"));
    expect(onApply).toHaveBeenCalledWith(liabilitySuggestion, {
      withComment: false,
      alternateId: alt.id,
    });
  });

  it("shows a decision instead of actions, and offers a re-run on drift", async () => {
    const applied = sampleFindings[1] as Finding;
    render(<SuggestionCard item={ruleItem(applied)} onApply={vi.fn()} />);
    expect(screen.getByText("Applied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    cleanup();
    const onRerun = vi.fn();
    const drifted = {
      ...liability,
      suggestion: { ...liabilitySuggestion, status: "anchor_failed" as const },
    };
    render(<SuggestionCard item={ruleItem(drifted)} onRerun={onRerun} />);
    await userEvent.setup().click(button("Re-run this rule"));
    expect(onRerun).toHaveBeenCalledWith(liability.rule_id);
  });

  it("names a gap by its kind and risk", () => {
    render(<SuggestionCard item={gapItem(sampleGaps[0] ?? ({} as never))} />);
    expect(screen.getByText("High risk")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Clause outside the playbook" })).toBeTruthy();
  });
});
