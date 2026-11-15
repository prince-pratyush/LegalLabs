// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../tooltip.js";
import { type PlaybookDraft, toEditable } from "./draft.js";
import { sampleRules } from "./fixtures.js";
import { PlaybookBuilder } from "./playbook-builder.js";

afterEach(cleanup);

const start: PlaybookDraft = {
  name: "SaaS MSA",
  contract_type: "MSA",
  guidance: "",
  rules: sampleRules.map(toEditable),
};

type Props = Partial<ComponentProps<typeof PlaybookBuilder>>;

function Harness({ onDraft, ...props }: Props & { onDraft?: (d: PlaybookDraft) => void }) {
  const [draft, setDraft] = useState(start);
  return (
    <TooltipProvider>
      <PlaybookBuilder
        draft={draft}
        onChange={(d) => {
          setDraft(d);
          onDraft?.(d);
        }}
        status="unpublished"
        versionNo={2}
        access="manage"
        dirty={draft !== start}
        onSave={vi.fn()}
        onPublish={vi.fn()}
        onUnpublish={vi.fn()}
        {...props}
      />
    </TooltipProvider>
  );
}

const disabled = (name: string) =>
  (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

describe("PlaybookBuilder", () => {
  // Many clicks in one test, so it gets more time on a busy CI runner.
  it("adds, reorders and deletes rules, then saves", { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    let latest = start;
    render(<Harness onSave={onSave} onDraft={(d) => (latest = d)} />);
    expect(disabled("Save version")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Move Governing law up" }));
    expect(latest.rules.map((r) => r.title)).toEqual(["Governing law", "Limitation of liability"]);

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    // A new rule opens ready to type into, and can't be saved until it has a title.
    expect(disabled("Save version")).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Termination" } });
    fireEvent.change(screen.getByLabelText("Standard position"), {
      target: { value: "Either party on 30 days." },
    });
    await user.click(screen.getByRole("button", { name: "Add fallback" }));
    fireEvent.change(screen.getByLabelText("Fallback 1"), { target: { value: "60 days." } });
    expect(latest.rules[2]).toMatchObject({ title: "Termination", fallbacks: ["60 days."] });

    await user.click(screen.getByRole("button", { name: "Delete Limitation of liability" }));
    expect(latest.rules.map((r) => r.title)).toEqual(["Governing law", "Termination"]);
    await user.click(screen.getByRole("button", { name: "Save version" }));
    expect(onSave).toHaveBeenCalledOnce();
    // Publishing waits for the save.
    expect(disabled("Publish")).toBe(true);
  });

  it("lets an author save but not publish", () => {
    render(<Harness access="edit" />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByText(/An approver publishes it/)).toBeTruthy();
  });

  it("asks an approver to publish saved changes; readers still get the old version", () => {
    render(<Harness status="published" publishedVersionNo={1} unpublishedChanges />);
    expect(screen.getByText(/Readers and reviews still get version 1/)).toBeTruthy();
    expect(disabled("Publish changes")).toBe(false);
  });

  it("stops a save that would undo someone else's, and offers a reload", () => {
    const onReload = vi.fn();
    render(<Harness stale onReload={onReload} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Someone else changed this playbook/);
    expect(disabled("Save version")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("offers a review entry point only once published", () => {
    render(<Harness status="unpublished" onReview={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Review a contract" })).toBeNull();
    cleanup();
    render(<Harness status="published" />);
    expect(disabled("Review a contract")).toBe(true);
    expect(disabled("Unpublish")).toBe(false);
  });

  it("starts a review when given a handler", async () => {
    const onReview = vi.fn();
    render(<Harness status="published" onReview={onReview} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Review a contract" }));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it("shows a past version read-only", () => {
    render(<Harness viewingVersion={1} onBackToCurrent={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save version" })).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
  });
});
