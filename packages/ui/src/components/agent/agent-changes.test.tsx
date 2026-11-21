// @vitest-environment jsdom
import { diffWords } from "@legallabs/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChanges } from "./agent-changes.js";

afterEach(cleanup);

const none = { added: [], removed: [] };

describe("AgentChanges", () => {
  it("shows a word redline, then each side on its own", async () => {
    const { container } = render(
      <AgentChanges
        ops={diffWords("Flag the cap.", "Flag the liability cap.")}
        attachments={none}
        sources={none}
        fromLabel="Live"
        toLabel="Draft"
      />,
    );
    expect(container.querySelector("ins")?.textContent).toContain("liability ");
    await userEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.getByRole("button", { name: "Side by side" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.querySelectorAll("ins")).toHaveLength(1);
    expect(container.textContent).toContain("Flag the cap.");
  });

  it("lists attachments added and removed, and accepts or discards", async () => {
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    render(
      <AgentChanges
        ops={[{ op: "equal", text: "Same" }]}
        attachments={{
          added: [{ kind: "vault", label: "Precedents", name: "Precedents vault" }],
          removed: [{ kind: "upload", label: "Old", name: "old.docx" }],
        }}
        sources={none}
        fromLabel="Live"
        toLabel="Draft"
        onAccept={onAccept}
        onDiscard={onDiscard}
      />,
    );
    expect(screen.getByText("Added:", { exact: false })).toBeTruthy();
    expect(screen.getByText("@Old")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
