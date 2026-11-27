import { describe, expect, it } from "vitest";
import {
  IntakeEscalation,
  IntakeRequestCreate,
  IntakeStatusChange,
  IntakeTypeCreate,
  IntakeTypePatch,
  intakeCanMove,
  intakeCheckFields,
  intakeSlaState,
} from "./intake.js";

const ID = "0190a6c2-0000-7000-8000-000000000001";
const field = (over: Record<string, unknown> = {}) => ({
  key: "counterparty",
  label: "Counterparty",
  type: "text",
  required: true,
  ...over,
});
const type = (over: Record<string, unknown> = {}) => ({
  name: "NDA",
  fields: [field()],
  sla_hours: 8,
  ...over,
});

describe("request type definitions", () => {
  it("fills in the optional parts", () => {
    const parsed = IntakeTypeCreate.parse(type());
    expect(parsed).toMatchObject({
      description: "",
      routing: null,
      default_owners: [],
      reviewers: [],
      escalations: [],
      keyword_rules: [],
      awaiting_requester_timeout_hours: 72,
    });
    expect(parsed.fields[0]).toMatchObject({ prompt: "" });
  });

  it("refuses bad keys, repeated keys, select without options and too many fields", () => {
    for (const fields of [
      [field({ key: "Bad Key" })],
      [field(), field()],
      [field({ type: "select" })],
      [field({ type: "select", options: [] })],
      Array.from({ length: 21 }, (_, i) => field({ key: `k_${"a".repeat(i + 1)}` })),
    ]) {
      expect(IntakeTypeCreate.safeParse(type({ fields })).success).toBe(false);
    }
    expect(IntakeTypeCreate.safeParse(type({ sla_hours: 721 })).success).toBe(false);
  });

  it("takes escalation conditions as data, never as an expression", () => {
    const good = {
      when: [
        { field: "value", op: "gt", value: 100000 },
        { unassigned_for_hours: 4 },
        { sla: "breached" },
      ],
      action: "notify",
      target: { user_id: ID },
    };
    expect(IntakeEscalation.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, when: "fields.value > 100000 && !assignee" },
      { ...good, when: [] },
      { ...good, when: [{ field: "value", op: "matches", value: ".*" }] },
      { ...good, when: [{ field: "value", op: "gt", value: "lots" }] },
      { ...good, when: [{ sla: "breached", extra: 1 }] },
    ]) {
      expect(IntakeEscalation.safeParse(bad).success).toBe(false);
    }
  });

  it("knows three routing targets and nothing else", () => {
    for (const routing of [
      { kind: "agent", agent_id: ID, post_results_to_requester: false },
      { kind: "contract_intelligence", ci_agent_id: ID },
      { kind: "lawyer", space_id: ID, assignment: [{ kind: "fixed", user_id: ID }] },
    ]) {
      expect(IntakeTypeCreate.safeParse(type({ routing })).success).toBe(true);
    }
    const url = { kind: "webhook", url: "https://example.com" };
    expect(IntakeTypeCreate.safeParse(type({ routing: url })).success).toBe(false);
  });

  it("refuses an empty patch and does not default what a patch leaves out", () => {
    expect(IntakeTypePatch.safeParse({}).success).toBe(false);
    expect(IntakeTypePatch.parse({ name: "NDA v2" })).toEqual({ name: "NDA v2" });
  });
});

describe("manual requests", () => {
  const base = { requester: { display_name: "Jo Smith" } };

  it("takes a requester who is not a user", () => {
    expect(IntakeRequestCreate.parse(base)).toMatchObject({ fields: {}, attachments: [] });
  });

  it("bounds what a requester's words can hold", () => {
    for (const bad of [
      { requester: { display_name: " " } },
      { ...base, fields: { "Not a key": "x" } },
      { ...base, fields: { note: "x".repeat(5001) } },
      { ...base, fields: { note: { nested: true } } },
      { ...base, attachments: Array.from({ length: 21 }, () => ID) },
      { ...base, attachments: [ID, ID] },
      { ...base, channel: "slack" },
      { requester: { display_name: "Jo", email: "not an address" } },
    ]) {
      expect(IntakeRequestCreate.safeParse(bad).success).toBe(false);
    }
  });
});

describe("field values against a type", () => {
  const defs = IntakeTypeCreate.parse(
    type({
      fields: [
        field(),
        field({ key: "mutual", type: "boolean" }),
        field({ key: "value", type: "money", required: false }),
        field({ key: "needed_by", type: "date", required: false }),
        field({ key: "kind", type: "select", options: ["a", "b"], required: false }),
        field({ key: "matter", type: "matter", required: false }),
        field({ key: "draft", type: "file", required: false }),
      ],
    }),
  ).fields;

  it("lists required fields still missing; false and zero are answers", () => {
    expect(intakeCheckFields(defs, {})).toEqual({
      missing: ["counterparty", "mutual"],
      invalid: [],
    });
    expect(intakeCheckFields(defs, { counterparty: "Acme", mutual: false, value: 0 })).toEqual({
      missing: [],
      invalid: [],
    });
    expect(intakeCheckFields(defs, { counterparty: "  ", mutual: true }).missing).toEqual([
      "counterparty",
    ]);
  });

  it("flags values of the wrong shape and keys the type doesn't have", () => {
    const result = intakeCheckFields(defs, {
      counterparty: 5,
      mutual: "yes",
      value: -1,
      needed_by: "2026-02-30",
      kind: "c",
      matter: "Falcon",
      draft: "x",
      surprise: "x",
    });
    expect(result.invalid.sort()).toEqual(
      [
        "counterparty",
        "draft",
        "kind",
        "matter",
        "mutual",
        "needed_by",
        "surprise",
        "value",
      ].sort(),
    );
    // A required field with an unusable value is still missing.
    expect(result.missing).toEqual(["counterparty", "mutual"]);
  });
});

describe("status", () => {
  it("moves forward as described and never reopens", () => {
    expect(intakeCanMove("new", "triaged")).toBe(true);
    expect(intakeCanMove("unclassified", "closed")).toBe(true);
    expect(intakeCanMove("triaged", "in_progress")).toBe(true);
    expect(intakeCanMove("in_progress", "waiting_approval")).toBe(true);
    expect(intakeCanMove("in_progress", "done")).toBe(true);
    expect(intakeCanMove("awaiting_requester", "triaged")).toBe(true);
    expect(intakeCanMove("new", "done")).toBe(false);
    expect(intakeCanMove("triaged", "new")).toBe(false);
    for (const from of ["done", "closed"] as const) {
      for (const to of ["triaged", "in_progress", "closed", "done"] as const) {
        expect(intakeCanMove(from, to)).toBe(false);
      }
    }
  });

  it("needs a reason to close and only then", () => {
    expect(IntakeStatusChange.safeParse({ status: "closed" }).success).toBe(false);
    expect(IntakeStatusChange.safeParse({ status: "closed", reason: "duplicate" }).success).toBe(
      true,
    );
    expect(IntakeStatusChange.safeParse({ status: "done", reason: "x" }).success).toBe(false);
    expect(IntakeStatusChange.safeParse({ status: "new" }).success).toBe(false);
  });
});

describe("SLA state", () => {
  const made = new Date("2026-03-01T00:00:00Z");
  const due = new Date("2026-03-01T08:00:00Z");
  const at = (hours: number) => new Date(made.getTime() + hours * 3_600_000);

  it("is at risk from three quarters of the way and breached when due", () => {
    expect(intakeSlaState(made, due, at(5.9))).toBe("ok");
    expect(intakeSlaState(made, due, at(6))).toBe("at_risk");
    expect(intakeSlaState(made, due, at(7.99))).toBe("at_risk");
    expect(intakeSlaState(made, due, at(8))).toBe("breached");
  });
});
