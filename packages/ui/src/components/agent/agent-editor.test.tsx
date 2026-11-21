// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEditor } from "./agent-editor.js";
import { type AgentContent, toLabel, unresolvedLabels } from "./types.js";

afterEach(cleanup);

const empty: AgentContent = { instructions: "", attachments: [], sources: [] };

function Harness(props: Partial<ComponentProps<typeof AgentEditor>> & { start?: AgentContent }) {
  const [value, setValue] = useState(props.start ?? empty);
  return (
    <>
      <AgentEditor
        attachChoices={[{ kind: "vault", ref: "v1", name: "Precedents vault" }]}
        sourceChoices={[{ kind: "knowledge_source", source: "s1", name: "Case law" }]}
        onSave={() => {}}
        hasLive={false}
        {...props}
        value={value}
        onChange={setValue}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

const current = () => JSON.parse(screen.getByTestId("value").textContent ?? "{}") as AgentContent;

describe("labels", () => {
  it("turns a file name into a label the API accepts", () => {
    expect(toLabel("2024 NDA (final).docx")).toBe("NDA final");
    expect(toLabel("___")).toBe("Attachment");
  });

  it("finds @names with nothing behind them", () => {
    expect(
      unresolvedLabels({
        instructions: "Use @Playbook then @Missing and @Missing again, not me@example.com",
        attachments: [{ label: "Playbook", kind: "playbook", ref: "p", name: "P" }],
        sources: [],
      }),
    ).toEqual(["Missing"]);
  });
});

describe("AgentEditor", () => {
  it("offers a slot to attach an unresolved @name and fills it", async () => {
    render(<Harness start={{ ...empty, instructions: "Check against @Precedents." }} />);
    expect(screen.getByText(/1 name in the instructions has nothing attached/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Attach @Precedents" }));
    await userEvent.selectOptions(screen.getByLabelText("What to attach"), "vault:v1");
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Precedents");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(current().attachments).toEqual([
      { label: "Precedents", kind: "vault", ref: "v1", name: "Precedents vault" },
    ]);
    expect(screen.queryByText(/nothing attached/)).toBeNull();
  });

  it("refuses a label already in use", async () => {
    render(
      <Harness
        start={{
          ...empty,
          sources: [{ label: "Precedents", kind: "knowledge_source", source: "s9" }],
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add file" }));
    await userEvent.selectOptions(screen.getByLabelText("What to attach"), "vault:v1");
    await userEvent.clear(screen.getByLabelText("Label"));
    await userEvent.type(screen.getByLabelText("Label"), "precedents");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already uses that label/);
    expect(current().attachments).toEqual([]);
  });

  it("stops adding at the limits and shows the counts", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      label: `S${i}`,
      kind: "knowledge_source" as const,
      source: `s${i}`,
    }));
    render(<Harness start={{ ...empty, sources }} />);
    expect(screen.getByText("5 of 5")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("An agent can use up to 5 sources.")).toBeTruthy();
  });

  it("saves live or as a draft", async () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(onSave.mock.calls).toEqual([[true], [false]]);
  });

  it("removes an attachment", async () => {
    render(
      <Harness
        start={{
          ...empty,
          attachments: [{ label: "Playbook", kind: "playbook", ref: "p", name: "P" }],
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove @Playbook" }));
    expect(current().attachments).toEqual([]);
  });
});
