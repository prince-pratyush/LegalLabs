// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomiseReviewForm } from "./customise-review-form.js";
import { sampleRuleChoices } from "./fixtures.js";

afterEach(cleanup);

const setup = (props: Partial<Parameters<typeof CustomiseReviewForm>[0]> = {}) => {
  const onSubmit = vi.fn();
  render(
    <CustomiseReviewForm
      playbookId="p1"
      documentId="d1"
      rules={sampleRuleChoices}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      {...props}
    />,
  );
  return { onSubmit, user: userEvent.setup() };
};

const run = () => screen.getByRole("button", { name: "Run review" }) as HTMLButtonElement;

describe("CustomiseReviewForm", () => {
  it("sends the defaults: their paper, standard mode, every rule", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText("Representing"), "Northwind (Customer)");
    await user.click(run());
    expect(onSubmit).toHaveBeenCalledWith(
      { party: "Northwind (Customer)", paper: "theirs", mode: "standard", scope: "all" },
      { draft: false },
    );
  });

  it("sends chosen rules in playbook order with the other settings", async () => {
    const { onSubmit, user } = setup({ canUseDraft: true });
    await user.click(screen.getByLabelText("Ours"));
    await user.click(screen.getByLabelText(/In depth/));
    await user.click(screen.getByLabelText("Selected rules"));
    expect(run().disabled).toBe(true);
    await user.click(screen.getByLabelText("Payment terms"));
    await user.click(screen.getByLabelText("Limitation of liability"));
    await user.type(screen.getByRole("textbox", { name: "Governing law" }), "uk");
    await user.type(screen.getByLabelText("Extra context"), "Renewal of an existing deal.");
    await user.click(screen.getByLabelText("Use the latest unpublished version"));
    await user.click(run());
    expect(onSubmit).toHaveBeenCalledWith(
      {
        party: "",
        paper: "ours",
        mode: "in_depth",
        scope: [sampleRuleChoices[0]?.id, sampleRuleChoices[2]?.id],
        jurisdiction: "UK",
        extra_context: { text: "Renewal of an existing deal.", document_ids: [] },
      },
      { draft: true },
    );
  });

  it("refuses a malformed governing law and warns about long documents", async () => {
    const { user } = setup({ pages: 120 });
    expect(screen.getByText(/Reviews over 100 pages/)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Governing law" }), "England");
    expect(screen.getByText(/two-letter region code/)).toBeTruthy();
    expect(run().disabled).toBe(true);
  });

  it("waits for a document and the playbook's rules", () => {
    setup({ documentId: null, documents: [] });
    expect(screen.getByText(/Upload a contract first/)).toBeTruthy();
    expect(run().disabled).toBe(true);
  });
});
