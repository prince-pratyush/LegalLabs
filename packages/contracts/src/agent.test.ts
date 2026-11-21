import { describe, expect, it } from "vitest";
import {
  AgentRunError,
  approvalFor,
  DEFAULT_APPROVAL,
  levelRefusal,
  nextScheduledRun,
  RunSignal,
  Schedule,
  SkillManifest,
  scopeOf,
} from "./index.js";

const admin = { agentsAdmin: true };
const member = { agentsAdmin: false };

describe("approval matrix", () => {
  const cases: [string, Parameters<typeof scopeOf>, typeof member, boolean, string | null][] = [
    ["a user", ["user", false], member, false, null],
    ["a group", ["group", false], member, false, null],
    ["the workspace", ["workspace", false], member, true, "agents_admin"],
    ["an internal space", ["space", false], member, false, null],
    ["an external space", ["space", true], member, true, "space_admin"],
    ["the workspace, by an admin", ["workspace", false], admin, false, null],
    ["an external space, by an agents admin", ["space", true], admin, true, "space_admin"],
  ];
  it.each(cases)("%s", (_name, [principal, external], who, required, approver) => {
    const result = approvalFor(DEFAULT_APPROVAL, scopeOf(principal, external), who);
    expect(result.required).toBe(required);
    if (result.required) expect(result.approver).toBe(approver);
  });

  it("lets admins require approval for people and groups, and waive the workspace", () => {
    const strict = { individual: true, group: true, workspace: false };
    expect(approvalFor(strict, "individual", member).required).toBe(true);
    expect(approvalFor(strict, "group", member).required).toBe(true);
    expect(approvalFor(strict, "workspace", member).required).toBe(false);
    expect(approvalFor(strict, "group", admin).required).toBe(false);
  });

  it("skips approval for a space's own admin", () => {
    expect(
      approvalFor(DEFAULT_APPROVAL, "external_space", { agentsAdmin: false, spaceAdmin: true })
        .required,
    ).toBe(false);
  });

  it("only builders hold edit or full, and guests only run through a space", () => {
    expect(levelRefusal("edit", { build: false, guest: false }, "individual")).toBe(
      "LEVEL_REQUIRES_BUILD_PERMISSION",
    );
    expect(levelRefusal("full", { build: true, guest: false }, "individual")).toBeNull();
    expect(levelRefusal("run", { build: false, guest: false }, "individual")).toBeNull();
    expect(levelRefusal("run", { build: false, guest: true }, "individual")).toBe("GUEST_RUN_ONLY");
    expect(levelRefusal("run", { build: false, guest: true }, "external_space")).toBeNull();
    expect(levelRefusal("view", { build: false, guest: true }, "external_space")).toBe(
      "GUEST_RUN_ONLY",
    );
  });
});

describe("schedules", () => {
  const weekly = Schedule.parse({
    rule: "weekly",
    params: { weekdays: [1, 4] },
    time_local: "08:00",
    tz: "Europe/London",
  });

  it("finds Monday or Thursday 08:00 London in UTC, across DST", () => {
    // Friday 2026-03-20 → Monday 23 March, still GMT.
    expect(nextScheduledRun(weekly, new Date("2026-03-20T12:00:00Z"))?.toISOString()).toBe(
      "2026-03-23T08:00:00.000Z",
    );
    // Thursday 26 March 08:00 is GMT; Monday 30 March is BST (UTC+1) after the clocks change.
    expect(nextScheduledRun(weekly, new Date("2026-03-26T09:00:00Z"))?.toISOString()).toBe(
      "2026-03-30T07:00:00.000Z",
    );
    // Autumn: back to GMT on 25 October.
    expect(nextScheduledRun(weekly, new Date("2026-10-23T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });

  it("counts every N days from the anchor", () => {
    const every = Schedule.parse({
      rule: "every_n_days",
      params: { n: 3 },
      time_local: "09:30",
      tz: "Australia/Sydney",
      anchor_date: "2026-06-01",
    });
    expect(nextScheduledRun(every, new Date("2026-05-31T00:00:00Z"))?.toISOString()).toBe(
      "2026-05-31T23:30:00.000Z",
    );
    const after = nextScheduledRun(every, new Date("2026-05-31T00:00:00Z")) as Date;
    expect(nextScheduledRun(every, after)?.toISOString()).toBe("2026-06-03T23:30:00.000Z");
  });

  it("rejects bad zones, times and incomplete rules", () => {
    expect(Schedule.safeParse({ ...weekly, tz: "Mars/Base" }).success).toBe(false);
    expect(Schedule.safeParse({ ...weekly, time_local: "25:00" }).success).toBe(false);
    expect(
      Schedule.safeParse({ rule: "weekly", params: {}, time_local: "08:00", tz: "UTC" }).success,
    ).toBe(false);
    expect(
      Schedule.safeParse({
        rule: "every_n_days",
        params: { n: 91 },
        time_local: "08:00",
        tz: "UTC",
      }).success,
    ).toBe(false);
  });
});

describe("skill manifest and signals", () => {
  it("fills defaults", () => {
    const m = SkillManifest.parse({ schema: "counsel.skill/1", name: "NDA" });
    expect(m.instructions_path).toBe("SKILL.md");
    expect(m.attachments).toEqual([]);
    expect(m.defaults.response_mode).toBe("auto");
  });

  it("parses each signal", () => {
    expect(RunSignal.parse({ name: "cancel" }).name).toBe("cancel");
    expect(RunSignal.safeParse({ name: "answer_question", step_id: "s", answer: {} }).success).toBe(
      false,
    );
    expect(RunSignal.safeParse({ name: "delete" }).success).toBe(false);
  });

  it("carries a code on a run error", () => {
    expect(new AgentRunError("WALL_NO_ACCESSIBLE_CONTEXT").code).toBe("WALL_NO_ACCESSIBLE_CONTEXT");
  });
});
