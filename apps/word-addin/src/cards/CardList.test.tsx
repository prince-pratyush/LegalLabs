import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { paraHash } from "../edits/anchor.js";
import { fakeHost } from "../test/fake-host.js";
import { CardList, type Decision } from "./CardList.js";
import type { Card } from "./card.js";

const doc = ["Mutual NDA", "The term is ten (10) years.", "New York law applies."];

const card = async (
  n: number,
  paragraph: number,
  before: string,
  after: string,
): Promise<Card> => ({
  id: `c${n}`,
  kind: "not_acceptable",
  title: `Rule ${n}`,
  anchor: { paragraph_index: paragraph, para_hash: await paraHash(doc[paragraph] ?? "") },
  before,
  after,
  justification: "Our position",
  state: "pending",
  flag: false,
  ruleId: null,
});

function Harness(props: {
  cards: Card[];
  host: ReturnType<typeof fakeHost>["host"];
  onDecide?: (d: Decision) => Promise<void>;
}) {
  const [cards, setCards] = useState(props.cards);
  return (
    <CardList
      cards={cards}
      host={props.host}
      onChange={(id, state) =>
        setCards((list) => list.map((c) => (c.id === id ? { ...c, state } : c)))
      }
      {...(props.onDecide ? { onDecide: props.onDecide } : {})}
    />
  );
}

describe("CardList", () => {
  it("applies one card as a tracked change with its comment, and reports it", async () => {
    const fake = fakeHost([...doc]);
    const onDecide = vi.fn(async () => {});
    render(
      <Harness
        cards={[await card(1, 1, "ten (10)", "three (3)")]}
        host={fake.host}
        onDecide={onDecide}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply with comment" }));
    expect(await screen.findByText("Applied as a tracked change")).toBeTruthy();
    expect(fake.log.applied[0]).toMatchObject({
      track: true,
      edit: { comment: "Rule 1: Our position" },
    });
    expect(fake.paragraphs[1]).toBe("The term is three (3) years.");
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ state: "applied", withComment: true }),
    );
  });

  it("applies all in document order and stops at a clause that changed", async () => {
    const fake = fakeHost([...doc]);
    const stale = await card(2, 2, "New York", "NSW");
    fake.paragraphs[2] = "California law applies.";
    render(<Harness cards={[stale, await card(1, 1, "ten (10)", "three (3)")]} host={fake.host} />);
    await userEvent.click(screen.getByRole("button", { name: "Apply all" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, apply" }));
    expect(await screen.findByText(/Applied 1\. Stopped at "Rule 2"/)).toBeTruthy();
    expect(screen.getByText("Clause changed since review")).toBeTruthy();
  });

  it("offers copying instead of applying when Word can't track changes", async () => {
    const fake = fakeHost([...doc], { tracked: false, comments: false });
    render(<Harness cards={[await card(1, 1, "ten (10)", "three (3)")]} host={fake.host} />);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy suggested text" })).toBeTruthy();
  });

  it("dismisses without touching the document", async () => {
    const fake = fakeHost([...doc]);
    const onDecide = vi.fn(async () => {});
    render(
      <Harness
        cards={[await card(1, 1, "ten (10)", "three (3)")]}
        host={fake.host}
        onDecide={onDecide}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(fake.log.applied).toHaveLength(0);
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ state: "dismissed" }));
  });
});
