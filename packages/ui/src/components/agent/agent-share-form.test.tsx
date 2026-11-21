// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentShareForm } from "./agent-share-form.js";

afterEach(cleanup);

const search = async () => [
  { principalType: "user" as const, principalId: "u3", label: "Alex Kim" },
];

describe("AgentShareForm", () => {
  it("shares with a person at a chosen level", async () => {
    const onAdd = vi.fn();
    render(
      <AgentShareForm
        grants={[]}
        requests={[]}
        search={search}
        onAdd={onAdd}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText("Only you.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Name, email or group"), "Al");
    await userEvent.click(await screen.findByRole("button", { name: "Alex Kim" }));
    await userEvent.selectOptions(screen.getByLabelText("Access"), "view");
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onAdd).toHaveBeenCalledWith({ principalType: "user", principalId: "u3", level: "view" });
  });

  it("shares with the workspace, and explains Spaces are not there yet", async () => {
    const onAdd = vi.fn();
    render(
      <AgentShareForm
        grants={[]}
        requests={[]}
        search={search}
        policy={{ individual: false, group: false, workspace: true }}
        onAdd={onAdd}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/the whole workspace waits for an admin/)).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "A Space" }));
    expect(screen.getByText(/once Spaces are turned on/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in the workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onAdd).toHaveBeenCalledWith({ principalType: "workspace", level: "run" });
  });

  it("lists grants and pending requests, and removes a grant", async () => {
    const onRemove = vi.fn();
    render(
      <AgentShareForm
        grants={[{ id: "g1", principalType: "user", label: "Sam Lee", level: "full" }]}
        requests={[
          {
            id: "r1",
            principalType: "workspace",
            label: "Everyone",
            level: "run",
            status: "pending",
            reason: null,
          },
        ]}
        search={search}
        onAdd={() => {}}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText("Pending approval")).toBeTruthy();
    expect(screen.getByText("Sam Lee").closest("li")?.textContent).toContain("Full access");
    await userEvent.click(screen.getByRole("button", { name: "Stop sharing with Sam Lee" }));
    expect(onRemove).toHaveBeenCalledWith("g1");
  });
});
