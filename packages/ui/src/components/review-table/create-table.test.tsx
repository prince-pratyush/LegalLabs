// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateTablePanel } from "./create-table.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const base = {
  vaults: [{ id: "v1", name: "Falcon DD" }],
  threads: [{ id: "t1", title: "Leases" }],
  loadTree: async () => ({ folders: [{ id: "f1", name: "Leases" }], files: [] }),
  onClose: () => {},
};

describe("CreateTablePanel", () => {
  it("creates from a thread passed in", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateTablePanel {...base} initialThreadId="t1" onCreate={onCreate} />);
    await userEvent.click(screen.getByRole("button", { name: "Create table" }));
    expect(onCreate).toHaveBeenCalledWith({ source: { kind: "thread", thread_id: "t1" } });
  });

  it("refuses more than 50 uploads", async () => {
    const onCreate = vi.fn();
    render(<CreateTablePanel {...base} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole("tab", { name: "Upload files" }));
    const files = Array.from({ length: 51 }, (_, i) => new File(["x"], `f${i}.pdf`));
    fireEvent.change(screen.getByLabelText("Files to upload"), { target: { files } });
    await userEvent.click(screen.getByRole("button", { name: "Create table" }));
    expect(screen.getByRole("alert").textContent).toBe("Upload 50 files or fewer.");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("asks for a vault before creating", async () => {
    const onCreate = vi.fn();
    render(<CreateTablePanel {...base} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/^Name/), "DD");
    await userEvent.click(screen.getByRole("button", { name: "Create table" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose a vault.");
    expect(onCreate).not.toHaveBeenCalled();
  });
});
