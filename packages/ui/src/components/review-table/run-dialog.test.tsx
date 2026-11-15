// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateLine, RunDialog } from "./run-dialog.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const estimate = {
  cells: 10,
  locked_skipped: 1,
  verified_skipped: 2,
  est_cost_usd: 0.42,
  est_minutes: 3.2,
};

describe("estimateLine", () => {
  it("states cells, time, cost and what's kept", () => {
    expect(estimateLine(estimate)).toBe("10 cells · ~4 min · ~$0.42 · 3 locked or verified kept");
  });
});

describe("RunDialog", () => {
  it("defaults to a dry run on big tables and shows the estimate", async () => {
    const onRun = vi.fn();
    const estimator = vi.fn().mockResolvedValue(estimate);
    render(
      <RunDialog
        open
        onOpenChange={() => {}}
        columnLabel="Fee"
        rowCount={1204}
        estimate={estimator}
        onRun={onRun}
      />,
    );
    expect(
      (screen.getByRole("radio", { name: /Dry run on the first 10 rows/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(await screen.findByText(/Estimate: 10 cells/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start dry run" }));
    expect(onRun).toHaveBeenCalledWith({ scope: "dry_run", include_verified: false });
  });

  it("runs everything on a small table", async () => {
    const onRun = vi.fn();
    render(
      <RunDialog
        open
        onOpenChange={() => {}}
        columnLabel="Fee"
        rowCount={8}
        estimate={vi.fn().mockResolvedValue(estimate)}
        onRun={onRun}
      />,
    );
    expect(screen.queryByRole("radio", { name: /Dry run/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledWith({ scope: "all", include_verified: false });
  });
});
