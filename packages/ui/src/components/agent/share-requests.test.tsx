// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalSwitches, ShareRequestQueue } from "./share-requests.js";

afterEach(cleanup);

const request = {
  id: "q1",
  agentTitle: "NDA first pass",
  principalLabel: "Everyone",
  level: "run" as const,
  requestedBy: "Sam Lee",
  createdAt: "2026-11-20T09:00:00Z",
  status: "pending" as const,
  reason: null,
};

describe("ShareRequestQueue", () => {
  it("accepts, or denies with a reason", async () => {
    const onAccept = vi.fn();
    const onDeny = vi.fn();
    render(<ShareRequestQueue requests={[request]} onAccept={onAccept} onDeny={onDeny} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledWith("q1");
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByLabelText(/Reason/), "Not yet");
    await userEvent.click(screen.getByRole("button", { name: "Deny request" }));
    expect(onDeny).toHaveBeenCalledWith("q1", "Not yet");
  });
});

describe("ApprovalSwitches", () => {
  it("flips one switch at a time", async () => {
    const onChange = vi.fn();
    render(
      <ApprovalSwitches
        value={{ individual: false, group: false, workspace: true }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Sharing with a group" }));
    expect(onChange).toHaveBeenCalledWith({ individual: false, group: true, workspace: true });
  });
});
