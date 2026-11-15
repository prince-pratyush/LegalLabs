// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellDrawer, type DrawerDetail } from "./cell-drawer.js";
import { sampleCell } from "./fixtures.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const detail = (patch: Partial<DrawerDetail["cell"]> = {}): DrawerDetail => ({
  cell: {
    ...sampleCell(),
    reasoning: "Section 14.2.",
    looked_at: null,
    model: "local",
    cost_usd: 0,
    ...patch,
  },
  citations: [
    {
      id: "q1",
      ordinal: 1,
      document_name: "MSA.pdf",
      page: 14,
      quote: "governed by Delaware law",
      status: "ok",
      open_url: "#/x",
    },
  ],
  history: [],
});

const handlers = () => ({
  onClose: vi.fn(),
  onRerun: vi.fn(),
  onVerify: vi.fn(),
  onFlag: vi.fn(),
  onLock: vi.fn(),
  onSave: vi.fn(),
  onOpenCitation: vi.fn(),
});

describe("CellDrawer", () => {
  it("verifies, saves an edit and closes on Escape", async () => {
    const h = handlers();
    render(<CellDrawer columnLabel="Law" documentName="MSA.pdf" detail={detail()} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(h.onVerify).toHaveBeenCalledWith(true);
    const box = screen.getByLabelText("Cell value");
    await userEvent.clear(box);
    await userEvent.type(box, "England");
    await userEvent.click(screen.getByRole("button", { name: "Save value" }));
    expect(h.onSave).toHaveBeenCalledWith("England");
    await userEvent.keyboard("{Escape}");
    expect(h.onClose).toHaveBeenCalled();
  });

  it("jumps to a found citation", async () => {
    const h = handlers();
    render(<CellDrawer columnLabel="Law" documentName="MSA.pdf" detail={detail()} {...h} />);
    await userEvent.click(screen.getByRole("tab", { name: "Citations (1)" }));
    await userEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(h.onOpenCitation).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }));
  });

  it("disables changes on a locked cell but allows unlocking", async () => {
    const h = handlers();
    render(
      <CellDrawer
        columnLabel="Law"
        documentName="MSA.pdf"
        detail={detail({ locked: true })}
        {...h}
      />,
    );
    expect((screen.getByRole("button", { name: "Re-run" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(h.onLock).toHaveBeenCalledWith(false);
  });

  it("lists where it looked for a null cell", () => {
    const h = handlers();
    const looked = {
      documents: [{ document_id: "d1", pages: [2, 9] }],
      queries: ["break fee"],
      chunks_read: 4,
      note: "Read the fees section.",
    };
    render(
      <CellDrawer
        columnLabel="Fee"
        documentName="MSA.pdf"
        detail={detail({ status: "null", value_text: null, looked_at: looked })}
        {...h}
      />,
    );
    const region = screen.getByRole("region", { name: "Where I looked" });
    expect(region.textContent).toContain("pages 2, 9");
    expect(region.textContent).toContain("“break fee”");
  });
});
