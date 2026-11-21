// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddColumnForm } from "./add-column.js";
import { mentionAt, PromptField } from "./prompt-field.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const COLUMNS = [
  { id: "0194f3a0-0000-7000-8000-00000000000a", label: "Governing law" },
  { id: "0194f3a0-0000-7000-8000-00000000000b", label: "Term" },
];

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PromptField value={value} onChange={setValue} columns={COLUMNS} aria-describedby="x" />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe("mentionAt", () => {
  it("finds an @ at the start of a word and what follows it", () => {
    expect(mentionAt("Is @Gov", 7)).toEqual({ start: 3, query: "Gov" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("Is @{Gov", 8)).toEqual({ start: 3, query: "Gov" });
    expect(mentionAt("a@b", 3)).toBeNull();
    expect(mentionAt("Is @{Term} fine", 15)).toBeNull();
  });
});

describe("PromptField", () => {
  it("lists the columns after @ and narrows them as you type", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("textbox"), "Same as @");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Governing law",
      "Term",
    ]);
    await userEvent.type(screen.getByRole("textbox"), "te");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Term"]);
  });

  it("inserts the column with Enter, and closes the list", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("textbox"), "Same as @go{Enter}");
    expect(screen.getByTestId("value").textContent).toBe("Same as @{Governing law}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("inserts with a click and keeps the text around it", async () => {
    render(<Harness initial="Then " />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "@");
    await userEvent.click(screen.getByRole("option", { name: "Term" }));
    expect(screen.getByTestId("value").textContent).toBe("Then @{Term}");
  });

  it("closes on Escape without changing the text", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("textbox"), "@{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("value").textContent).toBe("@");
  });

  it("offers nothing when no column matches", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("textbox"), "@zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("AddColumnForm with mentions", () => {
  it("saves a mention as the column's id", async () => {
    const onAdd = vi.fn();
    render(<AddColumnForm onAdd={onAdd} columns={COLUMNS} />);
    await userEvent.type(screen.getByLabelText("Column name"), "Position");
    await userEvent.type(
      screen.getByLabelText("What to look for"),
      "Given @go{Enter}, is it fair?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: `Given @{${COLUMNS[0]?.id}}, is it fair?` }),
    );
  });

  it("says when a mention names no column", async () => {
    const onAdd = vi.fn();
    render(<AddColumnForm onAdd={onAdd} columns={COLUMNS} />);
    await userEvent.type(screen.getByLabelText("Column name"), "Position");
    await userEvent.type(screen.getByLabelText("What to look for"), "Given @{{Nothing}");
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(screen.getByRole("alert").textContent).toBe("There is no column called Nothing.");
    expect(onAdd).not.toHaveBeenCalled();
  });
});
