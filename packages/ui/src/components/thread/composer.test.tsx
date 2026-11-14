// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./composer.js";

afterEach(cleanup);

function Harness(props: Partial<ComposerProps>) {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={vi.fn()}
      onStop={vi.fn()}
      streaming={false}
      workIn={null}
      onWorkIn={vi.fn()}
      attachments={[]}
      onRemove={vi.fn()}
      onAttachFiles={vi.fn()}
      vaults={[]}
      selectedVaultIds={[]}
      onToggleVault={vi.fn()}
      sources={[]}
      selectedSourceIds={[]}
      onToggleSource={vi.fn()}
      models={[{ id: "auto", label: "Auto" }]}
      model="auto"
      onModel={vi.fn()}
      deepAnalysis={false}
      onDeepAnalysis={vi.fn()}
      mentionables={[
        { type: "document", id: "d1", label: "Lease.pdf" },
        { type: "vault", id: "v1", label: "Leases" },
      ]}
      onMention={vi.fn()}
      {...props}
    />
  );
}

describe("Composer", () => {
  it("sends on Enter and adds a line on Shift+Enter", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Ask a question" });
    await userEvent.type(box, "one{Shift>}{Enter}{/Shift}two");
    expect(box).toHaveProperty("value", "one\ntwo");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("does not send an empty question", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "  {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("picks a mention with the keyboard", async () => {
    const onMention = vi.fn();
    const onSend = vi.fn();
    render(<Harness onMention={onMention} onSend={onSend} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "see @lea");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onMention).toHaveBeenCalledWith({ type: "vault", id: "v1", label: "Leases" });
    expect(box).toHaveProperty("value", "see @Leases ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("explains why sending is off", () => {
    render(<Harness disabledReason="Too many vaults." />);
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Too many vaults.")).toBeTruthy();
  });

  it("shows Stop while streaming", async () => {
    const onStop = vi.fn();
    render(<Harness streaming onStop={onStop} />);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
