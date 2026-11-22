// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankSchedule, ScheduleForm, toSchedule, upcoming } from "./schedule-form.js";

afterEach(cleanup);

describe("schedule values", () => {
  it("send only the rule's own parameter", () => {
    const weekly = toSchedule({ ...blankSchedule("UTC"), weekdays: [1, 3], inputs: " x " });
    expect(weekly.params).toEqual({ weekdays: [1, 3], inputs: "x" });
    const every = toSchedule({ ...blankSchedule("UTC"), rule: "every_n_days", n: 2 });
    expect(every.params).toEqual({ n: 2 });
    expect(every.matter_id).toBeUndefined();
  });

  it("list the next runs in the chosen zone", () => {
    const from = new Date("2026-11-21T00:00:00Z"); // a Saturday
    const runs = upcoming({ ...blankSchedule("UTC"), weekdays: [1] }, 3, from);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-11-23T09:00:00.000Z",
      "2026-11-30T09:00:00.000Z",
      "2026-12-07T09:00:00.000Z",
    ]);
  });
});

describe("ScheduleForm", () => {
  it("saves weekly days, time zone and email", async () => {
    const onSave = vi.fn();
    render(
      <ScheduleForm
        initial={blankSchedule("UTC")}
        zones={["UTC", "Europe/London"]}
        onSave={onSave}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Wednesday" }));
    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "Europe/London");
    await userEvent.click(screen.getByRole("checkbox", { name: "Email me the results" }));
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ weekdays: [1, 3], tz: "Europe/London", email: true }),
    );
    expect(screen.getByRole("region", { name: "Next runs" })).toBeTruthy();
  });

  it("refuses a weekly rule with no days", async () => {
    const onSave = vi.fn();
    render(<ScheduleForm initial={blankSchedule("UTC")} zones={["UTC"]} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose at least one day.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says when a schedule is paused and why", () => {
    render(
      <ScheduleForm
        initial={blankSchedule("UTC")}
        zones={["UTC"]}
        state={{ paused: true, reason: "agent deleted", nextRunAt: null }}
        onSave={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/Paused: agent deleted/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove schedule" })).toBeTruthy();
  });
});
