import { describe, expect, it } from "vitest";
import { callHistory, type StepLog } from "./run-tools.js";

const log = (tool_result: Record<string, unknown>): StepLog[] => [
  { ordinal: 1, kind: "tool", output: { tool_result } },
];

describe("callHistory", () => {
  const sent = { name: "vendor.send_mail", arguments: { to: "a@firm.test" } };
  const args = '<tool-arguments-c0de>\n{"to":"a@firm.test"}\n</tool-arguments-c0de>';

  it.each(["ok", "error", "unknown"])(
    "shows what a sent call was made with, fenced as data (%s)",
    (status) => {
      expect(callHistory(log({ ...sent, status, text: "done" }), "c0de")).toContain(args);
    },
  );

  it.each(["blocked", "declined"])("never repeats a call that did not go out (%s)", (status) => {
    expect(callHistory(log({ ...sent, status }), "c0de")).not.toContain("a@firm.test");
  });

  it("reads a step recorded without arguments", () => {
    const seen = callHistory(log({ name: "v.search", status: "ok", text: "hit" }), "c0de");
    expect(seen).toBe("Call to v.search: returned\n<tool-result-c0de>\nhit\n</tool-result-c0de>");
  });

  it("cuts very long arguments", () => {
    const long = { ...sent, arguments: { body: "x".repeat(10_000) }, status: "ok", text: "" };
    expect(callHistory(log(long), "c0de").length).toBeLessThan(2_300);
  });
});
