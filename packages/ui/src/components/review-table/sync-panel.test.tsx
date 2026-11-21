// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncIndicator, type SyncInfo, SyncPanel } from "./sync-panel.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const OFF: SyncInfo = {
  mode: "off",
  folder_ids: null,
  notify: false,
  state: "off",
  pending_rows: 0,
  removed_rows: 0,
  last_synced_at: null,
};
const FOLDERS = [
  { id: "f1", name: "Loans" },
  { id: "f2", name: "Leases" },
];

describe("SyncIndicator", () => {
  it("shows nothing while sync is off", () => {
    const { container } = render(<SyncIndicator sync={OFF} onClick={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("is orange with a count while rows work, green when idle", () => {
    const onClick = vi.fn();
    render(
      <SyncIndicator
        sync={{ ...OFF, mode: "entire_vault", state: "pending", pending_rows: 3 }}
        onClick={onClick}
      />,
    );
    expect(screen.getByRole("button", { name: "Sync settings" }).textContent).toBe(
      "Sync pending (3)",
    );
    cleanup();
    render(
      <SyncIndicator sync={{ ...OFF, mode: "entire_vault", state: "idle" }} onClick={onClick} />,
    );
    expect(screen.getByRole("button", { name: "Sync settings" }).textContent).toBe("Files synced");
  });
});

describe("SyncPanel", () => {
  const panel = (sync: SyncInfo, handlers = {}) =>
    render(
      <SyncPanel
        sync={sync}
        folders={FOLDERS}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onSyncNow={vi.fn().mockResolvedValue(undefined)}
        onClose={() => {}}
        {...handlers}
      />,
    );

  it("turns sync on for the whole vault and asks to be told", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    panel(OFF, { onSave });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /Entire vault/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Tell me when sync adds rows" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ mode: "entire_vault", folder_ids: null, notify: true });
  });

  it("needs a folder before it saves selected folders", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    panel(OFF, { onSave });
    await userEvent.click(screen.getByRole("radio", { name: /Selected folders/ }));
    expect(screen.getByRole("alert").textContent).toBe("Choose at least one folder.");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Leases" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      mode: "selected_folders",
      folder_ids: ["f2"],
      notify: false,
    });
  });

  it("syncs now when on, and says how many files left the vault", async () => {
    const onSyncNow = vi.fn().mockResolvedValue(undefined);
    panel(
      {
        ...OFF,
        mode: "entire_vault",
        state: "idle",
        removed_rows: 2,
        last_synced_at: "2026-11-21T01:00:00Z",
      },
      { onSyncNow },
    );
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(onSyncNow).toHaveBeenCalled();
    expect(screen.getByText(/2 files have left the vault/)).toBeTruthy();
  });

  it("shows the server's refusal", async () => {
    panel(OFF, {
      onSave: vi.fn().mockRejectedValue(new Error("Only a table over a vault can sync.")),
    });
    await userEvent.click(screen.getByRole("radio", { name: /Entire vault/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Only a table over a vault can sync.",
    );
  });
});
