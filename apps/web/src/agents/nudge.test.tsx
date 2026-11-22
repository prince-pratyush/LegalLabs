import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "../testing.js";
import { AgentNudge, resetNudges } from "./nudge.js";

const ID = "0190a000-0000-7000-8000-0000000000a1";
const TEXT = "Please review this NDA for me";

afterEach(resetNudges);

describe("AgentNudge", () => {
  it("offers a matching shared agent, and stays quiet once dismissed in this thread", async () => {
    const sent = serve({
      "POST /api/v1/agents/nudge": () => [
        200,
        { nudge: { agent_id: ID, title: "NDA first pass" } },
      ],
      [`POST /api/v1/agents/${ID}/nudge/dismiss`]: () => [204, null],
    });
    const { rerender } = render(<AgentNudge text={TEXT} threadKey="t1" />);
    expect(await screen.findByRole("button", { name: "Run NDA first pass?" })).toBeTruthy();
    expect(sent.find((c) => c.route === "POST /api/v1/agents/nudge")?.body).toEqual({
      prompt: TEXT,
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(screen.queryByRole("button", { name: "Run NDA first pass?" })).toBeNull();
    await waitFor(() =>
      expect(sent.some((c) => c.route === `POST /api/v1/agents/${ID}/nudge/dismiss`)).toBe(true),
    );
    rerender(<AgentNudge text={`${TEXT} today`} threadKey="t1" />);
    await waitFor(() =>
      expect(sent.filter((c) => c.route === "POST /api/v1/agents/nudge")).toHaveLength(2),
    );
    expect(screen.queryByRole("button", { name: "Run NDA first pass?" })).toBeNull();
  });

  it("opens the agent rather than running it", async () => {
    serve({
      "POST /api/v1/agents/nudge": () => [
        200,
        { nudge: { agent_id: ID, title: "NDA first pass" } },
      ],
    });
    render(<AgentNudge text={TEXT} threadKey="t2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Run NDA first pass?" }));
    expect(window.location.hash).toBe(`#/agents/${ID}`);
  });

  it("asks nothing for short text, and stops asking where nudges aren't offered", async () => {
    const sent = serve({});
    const { rerender } = render(<AgentNudge text="hi" threadKey="t3" />);
    await new Promise((r) => setTimeout(r, 700));
    expect(sent).toHaveLength(0);
    rerender(<AgentNudge text={TEXT} threadKey="t3" />);
    await waitFor(() => expect(sent).toHaveLength(1));
    rerender(<AgentNudge text={`${TEXT} again`} threadKey="t3" />);
    await new Promise((r) => setTimeout(r, 700));
    expect(sent).toHaveLength(1);
  });
});
