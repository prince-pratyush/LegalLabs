// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveTemplateDialog, TemplateList, type TemplateSummary } from "./templates.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const T: TemplateSummary = {
  id: "t1",
  name: "Credit terms",
  description: "",
  categories: [],
  status: "draft",
  version: 1,
  columns: [{ key: "c1", label: "Law" }],
  my_access: "owner",
  rejected_note: null,
};

const handlers = () => ({
  onUse: vi.fn(),
  onTest: vi.fn(),
  onShare: vi.fn(),
  onPublish: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onDelete: vi.fn(),
});

const buttons = () => screen.getAllByRole("button").map((b) => b.textContent);

describe("TemplateList", () => {
  it("offers an owner use, test, share and delete, and approval only once tested", async () => {
    const h = handlers();
    render(<TemplateList templates={[T]} {...h} />);
    expect(buttons()).toEqual(["Use", "Test", "Share", "Delete"]);
    await userEvent.click(screen.getByRole("button", { name: "Test Credit terms" }));
    expect(h.onTest).toHaveBeenCalledWith(T);
    cleanup();
    render(<TemplateList templates={[{ ...T, status: "tested" }]} {...h} />);
    expect(buttons()).toContain("Ask for approval");
  });

  it("gives someone it is only shared with just Use", () => {
    render(
      <TemplateList
        templates={[{ ...T, my_access: "use", status: "published" }]}
        {...handlers()}
      />,
    );
    expect(buttons()).toEqual(["Use"]);
    expect(screen.getByText("Published")).toBeTruthy();
  });

  it("shows approve and reject to a reviewer of a waiting template", async () => {
    const h = handlers();
    render(
      <TemplateList templates={[{ ...T, status: "pending_approval", my_access: "edit" }]} {...h} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve Credit terms" }));
    expect(h.onApprove).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reject Credit terms" })).toBeTruthy();
    // Nobody tests or changes it while it waits.
    expect(buttons()).not.toContain("Test");
  });

  it("shows why a template was rejected, and an empty state", () => {
    render(
      <TemplateList
        templates={[{ ...T, status: "rejected", rejected_note: "Too vague" }]}
        {...handlers()}
      />,
    );
    expect(screen.getByText("Rejected: Too vague")).toBeTruthy();
    cleanup();
    render(<TemplateList templates={[]} {...handlers()} />);
    expect(screen.getByText(/No templates yet/)).toBeTruthy();
  });
});

describe("SaveTemplateDialog", () => {
  it("saves the name and splits the tags", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SaveTemplateDialog
        open
        onOpenChange={() => {}}
        defaultName="Deal review"
        columnCount={12}
        onSave={onSave}
      />,
    );
    expect(screen.getByText(/Keeps this table's 12 columns/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Practice areas"), "Finance, Real estate");
    await userEvent.type(screen.getByLabelText("Document types"), "credit agreement");
    await userEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(onSave).toHaveBeenCalledWith({
      name: "Deal review",
      description: "",
      categories: ["Finance", "Real estate"],
      document_tags: ["credit agreement"],
    });
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    render(
      <SaveTemplateDialog
        open
        onOpenChange={() => {}}
        defaultName="X"
        columnCount={1}
        onSave={vi.fn().mockRejectedValue(new Error("Not allowed."))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not allowed.");
  });
});
