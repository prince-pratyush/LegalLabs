// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./export-dialog.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

describe("ExportDialog", () => {
  it("exports Excel with the chosen options", async () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<ExportDialog open onOpenChange={onOpenChange} onExport={onExport} />);
    await userEvent.click(screen.getByLabelText("Include citations as a sheet"));
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "xlsx",
        include_citations: true,
        highlight_verified: true,
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("drops formatting for CSV", async () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(<ExportDialog open onOpenChange={() => {}} onExport={onExport} />);
    await userEvent.click(screen.getByRole("radio", { name: "CSV" }));
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: "csv", highlight_verified: false, classify_colors: false }),
    );
  });

  it("says why an export was refused", async () => {
    const onExport = vi.fn().mockRejectedValue(new Error("Downloads are off for this vault."));
    render(<ExportDialog open onOpenChange={() => {}} onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Downloads are off for this vault.",
    );
  });
});
