// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./question-card.js";

afterEach(cleanup);

const options = [
  { id: "a", label: "NDA playbook" },
  { id: "b", label: "Client positions" },
];

describe("QuestionCard", () => {
  it("answers with an option, text or a skip", async () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard text="Which?" options={options} allowText allowSkip onAnswer={onAnswer} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Client positions/ }));
    await userEvent.type(screen.getByLabelText("Your answer"), "Our own{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onAnswer.mock.calls).toEqual([
      [{ option_id: "b" }],
      [{ text: "Our own" }],
      [{ skip: true }],
    ]);
  });

  it("takes digits and S from the keyboard, but not while typing", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard text="Which?" options={options} allowText allowSkip onAnswer={onAnswer} />,
    );
    const card = screen.getByRole("region");
    fireEvent.keyDown(card, { key: "1" });
    fireEvent.keyDown(card, { key: "s" });
    fireEvent.keyDown(screen.getByLabelText("Your answer"), { key: "2" });
    expect(onAnswer.mock.calls).toEqual([[{ option_id: "a" }], [{ skip: true }]]);
  });

  it("names the builder's skip", () => {
    render(
      <QuestionCard
        text="Which?"
        options={[]}
        allowText
        allowSkip
        skipLabel="Skip remaining"
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Skip remaining" })).toBeTruthy();
  });
});
