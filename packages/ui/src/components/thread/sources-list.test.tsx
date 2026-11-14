// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerCitation } from "./answer.js";
import { SourcesList } from "./sources-list.js";

afterEach(cleanup);

const cite = (n: number, status: AnswerCitation["status"]): AnswerCitation => ({
  n,
  at: 0,
  status,
  documentName: "Lease.pdf",
  page: n,
  quote: `quote ${n}`,
});

describe("SourcesList", () => {
  it("opens only verified sources", async () => {
    const onOpen = vi.fn();
    render(<SourcesList citations={[cite(1, "ok"), cite(2, "mismatch")]} onOpen={onOpen} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(1);
    expect(screen.getByText("Couldn't verify on the page")).toBeTruthy();
  });

  it("sends unverified sources to onFlagged, never onOpen", async () => {
    const onOpen = vi.fn();
    const onFlagged = vi.fn();
    render(
      <SourcesList citations={[cite(2, "unresolved")]} onOpen={onOpen} onFlagged={onFlagged} />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onFlagged).toHaveBeenCalledWith(2);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
